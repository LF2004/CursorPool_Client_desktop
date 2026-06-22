const http = require('http');
const https = require('https');
const tls = require('tls');
const { Readable } = require('stream');
const { normalizeProxyUrl, resolveRelayOutboundProxy } = require('./cursor-relay-system-proxy');

function normalizeHeaders(headers = {}) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  Object.entries(headers).forEach(([key, value]) => {
    if (value !== undefined && value !== null) out[key] = value;
  });
  return out;
}

function headersFromNode(headers = {}) {
  const out = new Headers();
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => out.append(key, String(item)));
    } else if (value !== undefined && value !== null) {
      out.set(key, String(value));
    }
  });
  return out;
}

function makeAbortError() {
  const error = new Error('Fetch aborted');
  error.name = 'AbortError';
  return error;
}

function getProxyAuthorization(proxy) {
  if (!proxy.username) return '';
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function shouldBypassProxy(target) {
  const host = String(target.hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.local');
}

function createNodeResponse(res, url) {
  const body = typeof Readable.toWeb === 'function' ? Readable.toWeb(res) : res;
  const response = new Response(body, {
    status: res.statusCode || 0,
    statusText: res.statusMessage || '',
    headers: headersFromNode(res.headers),
  });
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
  } catch {
    /* ignore */
  }
  return response;
}

function requestHttpViaProxy(target, proxy, options, signal) {
  return new Promise((resolve, reject) => {
    const headers = normalizeHeaders(options.headers);
    headers.Host = target.host;
    const auth = getProxyAuthorization(proxy);
    if (auth) headers['Proxy-Authorization'] = auth;

    const transport = proxy.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: String(options.method || 'GET').toUpperCase(),
      path: target.href,
      headers,
    }, (res) => {
      resolve(createNodeResponse(res, target.href));
    });
    req.on('error', reject);

    const abort = () => {
      req.destroy(makeAbortError());
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', abort));
    }

    if (options.body !== undefined && options.body !== null) req.end(options.body);
    else req.end();
  });
}

function requestHttpsViaProxy(target, proxy, options, signal) {
  return new Promise((resolve, reject) => {
    const targetPort = Number(target.port) || 443;
    const proxyTransport = proxy.protocol === 'https:' ? https : http;
    const connectHeaders = {
      Host: `${target.hostname}:${targetPort}`,
      'Proxy-Connection': 'Keep-Alive',
    };
    const auth = getProxyAuthorization(proxy);
    if (auth) connectHeaders['Proxy-Authorization'] = auth;

    let upstreamReq = null;
    let secureSocket = null;
    const connectReq = proxyTransport.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
    });
    connectReq.on('error', reject);

    const abort = () => {
      const error = makeAbortError();
      connectReq.destroy(error);
      if (upstreamReq) upstreamReq.destroy(error);
      if (secureSocket) secureSocket.destroy(error);
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      connectReq.on('close', () => signal.removeEventListener('abort', abort));
    }

    connectReq.on('connect', (res, socket, head) => {
      if ((res.statusCode || 0) !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode || 0}`));
        return;
      }
      if (head?.length) socket.unshift(head);

      secureSocket = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
      }, () => {
        const headers = normalizeHeaders(options.headers);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'host')) {
          headers.Host = target.host;
        }
        upstreamReq = https.request({
          method: String(options.method || 'GET').toUpperCase(),
          path: `${target.pathname || '/'}${target.search || ''}`,
          headers,
          createConnection: () => secureSocket,
        }, (upstreamRes) => {
          resolve(createNodeResponse(upstreamRes, target.href));
        });
        upstreamReq.on('error', reject);
        if (options.body !== undefined && options.body !== null) upstreamReq.end(options.body);
        else upstreamReq.end();
      });
      secureSocket.on('error', reject);
    });
    connectReq.end();
  });
}

async function fetchViaHttpProxy(url, options = {}, proxyUrl = '') {
  const target = new URL(String(url || ''));
  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxy || shouldBypassProxy(target)) return fetch(url, options);
  const proxy = new URL(normalizedProxy);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error(`Unsupported outbound proxy protocol: ${proxy.protocol}`);
  }
  if (target.protocol === 'http:') return requestHttpViaProxy(target, proxy, options, options.signal);
  if (target.protocol === 'https:') return requestHttpsViaProxy(target, proxy, options, options.signal);
  return fetch(url, options);
}

function createProxyAwareFetch(proxyConfig = null, options = {}) {
  const resolved = proxyConfig && typeof proxyConfig === 'object'
    ? proxyConfig
    : resolveRelayOutboundProxy(options);
  const proxyUrl = resolved?.enabled ? String(resolved.url || '').trim() : '';
  const proxyFetch = async (url, fetchOptions = {}) => {
    if (!proxyUrl) return fetch(url, fetchOptions);
    return fetchViaHttpProxy(url, fetchOptions, proxyUrl);
  };
  proxyFetch.proxy = resolved || { enabled: false, url: '', source: 'none' };
  return proxyFetch;
}

module.exports = {
  createProxyAwareFetch,
  fetchViaHttpProxy,
};
