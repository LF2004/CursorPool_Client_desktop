const { readCursorLoginState, readAccountFromItemTable, getStateVscdbPath } = require('./cursor-local-state');

const APP_USER_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

function buildHeaders({ accessToken, authClientId, sessionId }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-client-key': String(authClientId || '').trim(),
    'x-cursor-client-version': '0.0.0-cursorpool',
    'x-ghost-mode': 'false',
    'x-new-onboarding-completed': 'true',
  };
  const session = String(sessionId || '').trim();
  if (session) headers['x-session-id'] = session;
  return headers;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseAppUser(raw) {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function callCursorDashboard(path, headers, body = {}) {
  const resp = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  const data = parseJsonSafe(raw);
  if (!resp.ok) {
    throw new Error(data?.message || data?.error || `Cursor dashboard request failed (${resp.status})`);
  }
  return data || {};
}

function centsToDollars(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : 0;
}

function buildUsageSummary(usage = {}) {
  const planUsage = usage.planUsage || {};
  const spendLimitUsage = usage.spendLimitUsage || {};
  return {
    enabled: usage.enabled !== false,
    billingCycleStart: Number(usage.billingCycleStart || 0),
    billingCycleEnd: Number(usage.billingCycleEnd || 0),
    displayThreshold: Number(usage.displayThreshold || 0),
    displayMessage: usage.displayMessage || '',
    autoModelSelectedDisplayMessage: usage.autoModelSelectedDisplayMessage || '',
    namedModelSelectedDisplayMessage: usage.namedModelSelectedDisplayMessage || '',
    planUsage: {
      total: centsToDollars(planUsage.totalSpend),
      included: centsToDollars(planUsage.includedSpend),
      bonus: centsToDollars(planUsage.bonusSpend),
      limit: centsToDollars(planUsage.limit),
      auto: centsToDollars(planUsage.autoSpend),
      api: centsToDollars(planUsage.apiSpend),
      totalPercentUsed: Number(planUsage.totalPercentUsed || 0),
      autoPercentUsed: Number(planUsage.autoPercentUsed || 0),
      apiPercentUsed: Number(planUsage.apiPercentUsed || 0),
      remainingBonus: Boolean(planUsage.remainingBonus),
      bonusTooltip: planUsage.bonusTooltip || '',
    },
    spendLimitUsage: {
      individualUsed: centsToDollars(spendLimitUsage.individualUsed),
      individualLimit: centsToDollars(spendLimitUsage.individualLimit),
      pooledLimit: centsToDollars(spendLimitUsage.pooledLimit),
      pooledRemaining: centsToDollars(spendLimitUsage.pooledRemaining),
      overallLimit: centsToDollars(spendLimitUsage.overallLimit),
      overallRemaining: centsToDollars(spendLimitUsage.overallRemaining),
      limitType: spendLimitUsage.limitType || '',
    },
    raw: usage,
  };
}

async function fetchCursorDashboardSnapshot() {
  const login = readCursorLoginState();
  if (!login.accessToken || login.hasValidAccessToken === false) {
    return {
      ok: false,
      loggedIn: Boolean(login.loggedIn),
      reason: 'not_logged_in',
      message: '未检测到可用的 Cursor 登录态',
    };
  }

  const dbPath = getStateVscdbPath();
  const accountRead = readAccountFromItemTable(dbPath);
  const appUser = parseAppUser(accountRead.account?.applicationUser || accountRead.account?.reactiveApplicationUser);
  const cursorCreds = appUser.cursorCreds && typeof appUser.cursorCreds === 'object' ? appUser.cursorCreds : {};
  const backendUrl = String(cursorCreds.backendUrl || 'https://api2.cursor.sh').replace(/\/+$/, '');
  const authClientId = String(cursorCreds.authClientId || 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB').trim();
  const headers = buildHeaders({
    accessToken: login.accessToken,
    authClientId,
    sessionId: '',
  });

  const usageUrl = `${backendUrl}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
  const planUrl = `${backendUrl}/aiserver.v1.DashboardService/GetPlanInfo`;

  const [usage, planInfo] = await Promise.all([
    callCursorDashboard(usageUrl, headers, {}),
    callCursorDashboard(planUrl, headers, {}),
  ]);

  return {
    ok: true,
    loggedIn: true,
    email: login.email || '',
    backendUrl,
    authClientId,
    usage: buildUsageSummary(usage),
    planInfo,
  };
}

module.exports = {
  fetchCursorDashboardSnapshot,
};
