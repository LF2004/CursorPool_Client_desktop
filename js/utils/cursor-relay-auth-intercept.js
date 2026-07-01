/**
 * cursor-relay-auth-intercept.js
 *
 * 认证/订阅接口拦截模块（修复 "Log in ⚡" 和模型列表问题）
 *
 * 逆向文档已确认的根因：
 *   Cursor 启动后按顺序调用：
 *     1. DashboardService/GetTeams      → 团队信息
 *     2. /auth/full_stripe_profile      → 订阅状态 (716次调用!)
 *     3. AiService/AvailableModels       → 模型列表
 *     4. AiService/GetDefaultModel       → 默认模型
 *
 *   问题1: 我们的 relay 转发这些请求到 Cursor 官方 API，
 *         但我们的 accessToken 是伪造的/过期的，
 *         官方返回 401/错误 → Cursor 设置 stripeMembershipType=FREE
 *         → 显示 "Log in ⚡" 而非 "Show context usage"
 *
 *   问题2: AvailableModels 请求到官方失败时返回空列表
 *         → Models 页面显示 "No models available"
 *
 * 解决方案：拦截这些关键请求，直接返回伪造但有效的响应
 */

const { buildConnectFrame } = require('./cursor-relay-protobuf');
const protocol = require('./cursor-relay-protocol');
const {
  readDefaultUserTemplate,
  parseTemplateToAccount,
  checkCursorLogin,
} = require('./cursor-relay-account-store');

// ── 需要拦截的路径 ────────────────────────────────────────

const AUTH_ENDPOINTS = {
  // 订阅状态 — 返回伪造的 PRO 订阅信息
  FULL_STRIPE_PROFILE: '/auth/full_stripe_profile',
  STRIPE_PROFILE: '/auth/stripe_profile',
  STRIPE: '/auth/stripe',           // [FIX #5] 新增：部分版本可能用此路径
  MEMBERSHIP: '/auth/membership',   // [FIX #5] 新增：会员信息端点
  OAUTH_TOKEN: '/oauth/token',      // [FIX #6] 新增：最新版先刷 token，再访问启动探活 RPC
  HAS_VALID_PAYMENT_METHOD: '/auth/has_valid_payment_method',
  LOGOUT: '/auth/logout',

  // 团队信息 — 返回空团队（避免 enterprise 检查）
  GET_TEAMS: '/DashboardService/GetTeams',
};

// ── 健康检查 / 指标上报端点（Connect RPC）──────────────────
// 这些请求转发到官方 API 会因 accessToken 无效返回 401 [unauthenticated]
// 直接返回空成功响应即可，Cursor 客户端不需要真实数据
const HEALTH_CHECK_ENDPOINTS = {
  PING: '/aiserver.v1.HealthService/Ping',
  UNARY: '/aiserver.v1.HealthService/Unary',
  STREAM: '/aiserver.v1.HealthService/Stream',
  STREAM_SSE: '/aiserver.v1.HealthService/StreamSSE',
  STREAM_BIDI_SSE: '/aiserver.v1.HealthService/StreamBidiSSE',
  STREAM_BIDI: '/aiserver.v1.HealthService/StreamBidi',
  STREAM_BIDI_POLL: '/aiserver.v1.HealthService/StreamBidiPoll',
  SERVER_TIME: '/aiserver.v1.AiService/ServerTime',
  REPORT_METRICS: '/aiserver.v1.AiService/ReportClientNumericMetrics',
  USAGE_LIMIT: '/aiserver.v1.AiService/GetUsageLimitPolicyStatus',
  HEALTH_CHECK: '/aiserver.v1.AiService/HealthCheck',
  PRIVACY_CHECK: '/aiserver.v1.AiService/PrivacyCheck',
  TIME_LEFT: '/aiserver.v1.AiService/TimeLeftHealthCheck',
  // agent.v1 也可能有 Ping
  AGENT_PING: '/agent.v1.AgentService/Ping',
  DASHBOARD_USAGE_AND_GRANTS: '/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants',
  FILESYNC_ENABLED: '/aiserver.v1.FileSyncService/FSIsEnabledForUser',
  NETWORK_IS_CONNECTED: '/aiserver.v1.NetworkService/IsConnected',
};

const HEALTH_CHECK_PATH_KEYWORDS = [
  'usagelimit',
  'usage_limit',
  'usage-limit',
  'grant',
  'activegrant',
  'active_grant',
  'active-grant',
];

// ── Membership Type 枚举值（从 workbench.desktop.main.js 提取） ──
// 关键：Cursor 的 cs 枚举使用全小写字符串！
//   cs.FREE="free", cs.PRO="pro", cs.ULTRA="ultra"
//   如果大小写不匹配，membershipType() 的 switch 会落入 default → FREE
const MEMBERSHIP_TYPES = {
  FREE: 'free',
  FREE_TRIAL: 'free_trial',
  PRO: 'pro',
  PRO_STUDENT: 'pro_student',
  PRO_PLUS: 'pro_plus',
  ULTRA: 'ultra',       // ← 用户 defult_user.json 写的 stripeMembershipType=ultra
  TEAM: 'team',
  ENTERPRISE: 'enterprise',
};

/**
 * 检查路径是否需要认证拦截
 * [FIX #5] 增强匹配：支持前缀匹配（某些 Cursor 版本可能带 query string 或不同路径格式）
 */
function isAuthEndpoint(pathname) {
  if (!pathname) return false;
  const normalized = pathname.split('?')[0].split('#')[0]; // 去掉 query/hash
  const values = Object.values(AUTH_ENDPOINTS);
  // 精确匹配
  if (values.some((p) => normalized === p || normalized.endsWith(p))) return true;
  // 宽松匹配：/auth/* 相关路径
  if (normalized === '/auth/stripe' || normalized === '/auth/membership' || normalized === '/oauth/token') return true;
  return false;
}

/**
 * 检查路径是否是认证相关（更宽泛匹配，用于日志等）
 */
function isAuthRelatedPath(pathname) {
  if (!pathname) return false;
  if (
    pathname.startsWith('/auth/')
    || pathname.startsWith('/oauth/')
    || pathname.toLowerCase().includes('stripe')
    || pathname.toLowerCase().includes('membership')
    || pathname.toLowerCase().includes('oauth')
  ) return true;
  if (pathname === AUTH_ENDPOINTS.GET_TEAMS) return true;
  return false;
}

/**
 * 检查路径是否是健康检查/指标上报端点
 * 这些端点转发到官方会返回 401，直接返回空成功响应
 */
function isHealthCheckPath(pathname) {
  if (!pathname) return false;
  const normalized = pathname.split('?')[0].split('#')[0];
  if (Object.values(HEALTH_CHECK_ENDPOINTS).some((p) => normalized === p || normalized.endsWith(p))) {
    return true;
  }
  const lowered = normalized.toLowerCase();
  return HEALTH_CHECK_PATH_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function isDiagnosticBypassHost(req) {
  const host = String(
    req?.headers?.host
    || req?.headers?.[':authority']
    || ''
  ).trim().toLowerCase();
  return host === 'marketplace.cursorapi.com' || host === 'prod.authentication.cursor.sh';
}

function buildCorsHeaders(req, extra = {}) {
  const origin = String(req?.headers?.origin || '').trim();
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': [
      'Authorization',
      'Content-Type',
      'X-Requested-With',
      'X-Cursor-Client-Version',
      'X-Cursor-Checksum',
      'X-Ghost-Mode',
      'X-Client-Key',
      'X-Session-Id',
      'X-New-Onboarding-Completed',
      'Accept',
      'Connect-Protocol-Version',
    ].join(', '),
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
}

function encodeVarint(value) {
  const out = [];
  let current = Number(value) >>> 0;
  while (current >= 0x80) {
    out.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  out.push(current);
  return Buffer.from(out);
}

function encodeStringField(fieldNumber, value) {
  const text = Buffer.from(String(value || ''), 'utf8');
  return Buffer.concat([
    encodeVarint((Number(fieldNumber) << 3) | 2),
    encodeVarint(text.length),
    text,
  ]);
}

function encodeBoolField(fieldNumber, value) {
  return Buffer.concat([
    encodeVarint((Number(fieldNumber) << 3) | 0),
    Buffer.from([value ? 1 : 0]),
  ]);
}

/**
 * 构建 ServerTime 的 Connect Protocol 响应
 * ServerTimeResponse { double receive_timestamp = 1; double transmit_timestamp = 2; }
 * proto3 double 编码：tag(1byte) + value(8bytes)
 */
function buildServerTimeConnectResponse() {
  const now = Date.now() / 1000;
  const buf = Buffer.alloc(1 + 8 + 1 + 8);
  let offset = 0;
  // field 1 (receive_timestamp): tag = (1 << 3) | 1 = 0x09, wire_type = 1 (64-bit)
  buf[offset++] = 0x09;
  buf.writeDoubleLE(now, offset); offset += 8;
  // field 2 (transmit_timestamp): tag = (2 << 3) | 1 = 0x11
  buf[offset++] = 0x11;
  buf.writeDoubleLE(now, offset); offset += 8;
  return buf.subarray(0, offset);
}

/**
 * 构建 GetUsageLimitPolicyStatus 的 Connect Protocol 响应
 * 空消息 = is_in_slow_pool=false（proto3 默认值）
 */
function buildUsageLimitConnectResponse() {
  // 空 protobuf 消息，所有字段都是默认值
  return Buffer.alloc(0);
}

function isProtoResponsePath(pathname) {
  const normalized = String(pathname || '');
  return normalized.includes('/aiserver.') || normalized.includes('/agent.');
}

function buildHealthUnaryResponsePayload(payload = 'ok') {
  return encodeStringField(1, payload);
}

function shouldUseConnectUnaryProtocol(req) {
  const contentType = String(req?.headers?.['content-type'] || '').toLowerCase();
  const connectVersion = String(req?.headers?.['connect-protocol-version'] || '').trim();
  return Boolean(connectVersion) || contentType.includes('application/connect+proto');
}

function buildUnaryHealthHeaders(req, bodyLength, extra = {}) {
  const headers = {
    'Content-Type': 'application/proto',
    'Content-Length': String(Math.max(0, Number(bodyLength) || 0)),
    ...buildCorsHeaders(req),
    ...extra,
  };
  if (shouldUseConnectUnaryProtocol(req)) {
    headers['Connect-Protocol-Version'] = '1';
  }
  return headers;
}

function flushResponse(res) {
  try {
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  } catch {
    /* ignore */
  }
  try {
    if (typeof res.flush === 'function') res.flush();
  } catch {
    /* ignore */
  }
}

function buildStreamingHealthConnectResponse(payload = 'foo', chunkCount = 5, metadata = {}) {
  const frames = [];
  const total = Math.max(1, Number(chunkCount) || 5);
  for (let index = 0; index < total; index += 1) {
    frames.push(buildConnectFrame(buildHealthUnaryResponsePayload(payload)));
  }
  frames.push(protocol.buildConnectEndFrame(metadata));
  return Buffer.concat(frames);
}

async function writeStreamingHealthConnectResponse(res, payload = 'foo', chunkCount = 5, metadata = {}) {
  const total = Math.max(1, Number(chunkCount) || 5);
  for (let index = 0; index < total; index += 1) {
    res.write(buildConnectFrame(buildHealthUnaryResponsePayload(payload)));
    flushResponse(res);
    // Cursor 诊断会检测是否逐段到达，必须制造真实的 chunked/streaming 行为。
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  res.write(protocol.buildConnectEndFrame(metadata));
  flushResponse(res);
  res.end();
}

function buildBidiPollConnectResponse(payload = 'foo', chunkCount = 5, metadata = {}) {
  const frames = [];
  const total = Math.max(1, Number(chunkCount) || 5);
  for (let index = 0; index < total; index += 1) {
    const framePayload = Buffer.concat([
      encodeVarint((1 << 3) | 0),
      encodeVarint(index + 1),
      encodeStringField(2, payload),
      ...(index === total - 1 ? [encodeBoolField(3, true)] : []),
    ]);
    frames.push(buildConnectFrame(framePayload));
  }
  frames.push(protocol.buildConnectEndFrame(metadata));
  return Buffer.concat(frames);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeUnaryHealthPayload(rawBody, fallback = '') {
  try {
    if (!rawBody?.length) return fallback;
    let offset = 0;
    while (offset < rawBody.length) {
      let tag = 0;
      let shift = 0;
      while (offset < rawBody.length) {
        const byte = rawBody[offset];
        offset += 1;
        tag |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      const fieldNumber = tag >> 3;
      const wireType = tag & 7;
      if (wireType === 2) {
        let length = 0;
        shift = 0;
        while (offset < rawBody.length) {
          const byte = rawBody[offset];
          offset += 1;
          length |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        if (fieldNumber === 1 && length >= 0 && offset + length <= rawBody.length) {
          return rawBody.subarray(offset, offset + length).toString('utf8') || fallback;
        }
        offset += Math.max(0, length);
      } else if (wireType === 0) {
        while (offset < rawBody.length && (rawBody[offset++] & 0x80) !== 0) {
          // skip varint
        }
      } else if (wireType === 1) {
        offset += 8;
      } else if (wireType === 5) {
        offset += 4;
      } else {
        break;
      }
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * 处理健康检查/指标上报请求：返回空成功响应
 * 避免转发到官方 API 导致 401 [unauthenticated]
 *
 * @returns {boolean} 是否已处理
 */
async function handleHealthCheckIntercept(req, res, pathname, config, logger) {
  if (!isHealthCheckPath(pathname)) return false;

  if (String(req?.method || '').toUpperCase() === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(req));
    res.end();
    return true;
  }

  const isStreaming = pathname.includes('Stream') || pathname.includes('Bidi');
  const method = req.method || 'POST';
  stats.authIntercepted = (stats.authIntercepted || 0) + 1;
  logger.info(`health-intercept: ${method} ${pathname} intercepted (streaming=${isStreaming})`);

  try {
    const rawBody = String(req?.method || '').toUpperCase() === 'POST'
      ? await readRequestBody(req)
      : Buffer.alloc(0);
    const requestPayload = decodeUnaryHealthPayload(
      rawBody,
      pathname === HEALTH_CHECK_ENDPOINTS.PING ? 'ping' : 'foo',
    );

    if (pathname === HEALTH_CHECK_ENDPOINTS.STREAM_BIDI_POLL) {
      const body = buildBidiPollConnectResponse(requestPayload || 'foo', 5, {});
      res.writeHead(200, {
        'Content-Type': 'application/connect+proto',
        'Connect-Protocol-Version': '1',
        'Content-Length': String(body.length),
        ...buildCorsHeaders(req),
      });
      res.end(body);
    } else if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'application/connect+proto',
        'Connect-Protocol-Version': '1',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Accel-Buffering': 'no',
        ...buildCorsHeaders(req),
      });
      flushResponse(res);
      await writeStreamingHealthConnectResponse(res, requestPayload || 'foo', 5, {});
    } else if (pathname === HEALTH_CHECK_ENDPOINTS.SERVER_TIME) {
      // ServerTime 需要返回时间戳
      const body = buildServerTimeConnectResponse();
      res.writeHead(200, buildUnaryHealthHeaders(req, body.length));
      res.end(body);
    } else if (pathname === HEALTH_CHECK_ENDPOINTS.PING || pathname === HEALTH_CHECK_ENDPOINTS.UNARY || pathname === HEALTH_CHECK_ENDPOINTS.AGENT_PING) {
      const body = buildHealthUnaryResponsePayload(requestPayload || 'ping');
      res.writeHead(200, buildUnaryHealthHeaders(req, body.length));
      res.end(body);
    } else if (
      pathname === HEALTH_CHECK_ENDPOINTS.FILESYNC_ENABLED
      || pathname === HEALTH_CHECK_ENDPOINTS.NETWORK_IS_CONNECTED
    ) {
      const body = Buffer.alloc(0);
      res.writeHead(200, buildUnaryHealthHeaders(req, body.length));
      res.end(body);
    } else {
      // 其他 unary 调用：返回空 protobuf（所有字段默认值）
      const isProto = isProtoResponsePath(pathname);
      const body = isProto ? buildUsageLimitConnectResponse() : '{}';
      const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
      res.writeHead(200, isProto
        ? buildUnaryHealthHeaders(req, length)
        : {
          'Content-Type': 'application/json',
          'Content-Length': String(length),
          ...buildCorsHeaders(req),
        });
      res.end(body);
    }

    logger.info(`health-intercept: ${pathname} returned fake response`);
    return true;
  } catch (e) {
    logger.error(`health-intercept error for ${pathname}: ${e.message}`);
    return false;
  }
}

function handleDiagnosticHostIntercept(req, res, pathname, logger) {
  if (!isDiagnosticBypassHost(req)) return false;
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(req));
    res.end();
    logger.info(`diag-host-intercept: ${method} ${pathname} returned preflight response`);
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD') return false;
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': '0',
    'Cache-Control': 'no-store',
    ...buildCorsHeaders(req),
  });
  res.end();
  logger.info(`diag-host-intercept: ${method} ${pathname} returned synthetic 200`);
  return true;
}

// ── 伪造响应构建 ─────────────────────────────────────────

/**
 * 构建 full_stripe_profile 的伪造响应
 *
 * Cursor 期望的字段（从 refreshMembership 反向推导）：
 *   - membershipType: string (PRO/FREE/etc)
 *   - subscriptionStatus: string (ACTIVE/CANCELLED/etc)
 *   - lastPaymentFailed: boolean
 *   - pendingCancellationDate: string
 *   - daysRemainingOnTrial: number
 *
 * @param {object} options
 * @returns {object} JSON 响应体
 */
function buildFakeStripeProfile(options = {}) {
  // 默认使用 ultra（匹配 defult_user.json 的 stripeMembershipType）
  // 值必须是小写，与 Cursor cs 枚举一致
  const membershipType = options.membershipType || MEMBERSHIP_TYPES.ULTRA;
  return {
    membershipType,
    subscriptionStatus: options.subscriptionStatus || 'ACTIVE',
    lastPaymentFailed: false,
    pendingCancellationDate: '',
    daysRemainingOnTrial: 999,
    customerId: 'cus_cursorpool_fake_' + Date.now().toString(36),
    email: options.email || 'user@cursorpool.local',
  };
}

/**
 * 构建 GetTeams 的伪造响应
 * 返回空数组（无团队）→ 避免 enterprise 检查逻辑干扰
 */
function buildFakeTeamsResponse() {
  return { teams: [] };
}

/**
 * 构建 HasValidPaymentMethod 的伪造响应
 */
function buildFakePaymentMethodResponse() {
  return { hasValidPaymentMethod: true };
}

/**
 * 构建 Logout 的伪造响应
 */
function buildFakeLogoutResponse() {
  return {};
}

function resolveRelayAccountSnapshot() {
  const loginState = checkCursorLogin();
  if (loginState?.loggedIn && loginState?.email && loginState?.accessToken) {
    return {
      email: String(loginState.email).trim(),
      accessToken: String(loginState.accessToken).trim(),
      refreshToken: String(loginState.refreshToken || loginState.accessToken).trim(),
      stripeMembershipType: MEMBERSHIP_TYPES.ULTRA,
      source: 'state.vscdb',
    };
  }

  const template = readDefaultUserTemplate();
  const templateAccount = parseTemplateToAccount(template);
  if (templateAccount?.email && templateAccount?.accessToken) {
    return {
      ...templateAccount,
      source: 'defult_user.json',
    };
  }

  return null;
}

function buildFakeOauthTokenResponse(account = null) {
  const fallbackToken = String(account?.accessToken || account?.refreshToken || '').trim();
  return {
    access_token: fallbackToken,
    id_token: fallbackToken,
    refresh_token: String(account?.refreshToken || fallbackToken).trim(),
    token_type: 'Bearer',
    expires_in: 604800,
    scope: 'openid profile email offline_access',
    shouldLogout: false,
  };
}

// ── 处理函数 ─────────────────────────────────────────────────

/**
 * 处理认证相关请求：直接返回伪造的成功响应
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname 请求路径
 * @param {object} config relay 配置
 * @param {object} logger 日志器
 * @returns {boolean} 是否已处理（true=已处理，不需要转发）
 */
function handleAuthIntercept(req, res, pathname, config, logger) {
  // 先检查健康检查/指标上报端点（Connect RPC）
  if (isHealthCheckPath(pathname)) return handleHealthCheckIntercept(req, res, pathname, config, logger);
  if (handleDiagnosticHostIntercept(req, res, pathname, logger)) return true;
  if (String(req?.method || '').toUpperCase() === 'OPTIONS' && (isAuthEndpoint(pathname) || isAuthRelatedPath(pathname))) {
    res.writeHead(204, buildCorsHeaders(req));
    res.end();
    return true;
  }
  if (!isAuthEndpoint(pathname)) return false;

  stats.authIntercepted = (stats.authIntercepted || 0) + 1;
  logger.info(`auth-intercept: ${pathname} intercepted`);

  try {
    let responseBody;
    let contentType = 'application/json';
    const relayAccount = resolveRelayAccountSnapshot();

    switch (pathname) {
      case AUTH_ENDPOINTS.FULL_STRIPE_PROFILE:
        responseBody = buildFakeStripeProfile({ email: relayAccount?.email || config.relayEmail });
        break;

      case AUTH_ENDPOINTS.STRIPE_PROFILE:
        // fallback: 返回 paymentId 字符串（Cursor 会包装成 {membershipType: PRO}）
        responseBody = 'pi_cursorpool_fake_' + Date.now().toString(36);
        break;

      // [FIX #5] /auth/stripe 和 /auth/membership 也返回完整 stripe profile
      case AUTH_ENDPOINTS.STRIPE:
      case AUTH_ENDPOINTS.MEMBERSHIP:
        responseBody = buildFakeStripeProfile({ email: relayAccount?.email || config.relayEmail });
        break;

      case AUTH_ENDPOINTS.OAUTH_TOKEN:
        responseBody = buildFakeOauthTokenResponse(relayAccount);
        break;

      case AUTH_ENDPOINTS.HAS_VALID_PAYMENT_METHOD:
        responseBody = buildFakePaymentMethodResponse();
        break;

      case AUTH_ENDPOINTS.GET_TEAMS:
        responseBody = buildFakeTeamsResponse();
        break;

      case AUTH_ENDPOINTS.LOGOUT:
        responseBody = buildFakeLogoutResponse();
        break;

      default:
        return false; // 未知的 auth 端点，放行
    }

    // 写入响应
    res.writeHead(200, {
      'Content-Type': contentType,
      ...buildCorsHeaders(req),
    });
    res.end(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));

    logger.info(`auth-intercept: ${pathname} returned fake response`);
    return true;
  } catch (e) {
    logger.error(`auth-intercept error for ${pathname}: ${e.message}`);
    return false; // 出错则转发到上游
  }
}

let stats = { authIntercepted: 0 };

module.exports = {
  AUTH_ENDPOINTS,
  HEALTH_CHECK_ENDPOINTS,
  MEMBERSHIP_TYPES,
  isAuthEndpoint,
  isAuthRelatedPath,
  isHealthCheckPath,
  handleHealthCheckIntercept,
  handleAuthIntercept,
  buildFakeStripeProfile,
  buildFakeTeamsResponse,
  stats,
};
