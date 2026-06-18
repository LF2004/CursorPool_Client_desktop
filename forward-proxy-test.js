#!/usr/bin/env node
const http = require('http')
const https = require('https')
const net = require('net')
const fs = require('fs')
const path = require('path')

const HOST = process.env.FORWARD_PROXY_HOST || '127.0.0.1'
const PORT = Number(process.env.FORWARD_PROXY_PORT || '9182')
const TIMEOUT_MS = 30000
const LOG_PATH = path.join(__dirname, 'forward-proxy-test.log')

function now() {
  return new Date().toISOString()
}

function log(message) {
  const line = `[forward-proxy-test] ${now()} ${message}`
  console.log(line)
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8')
  } catch {
    // ignore
  }
}

function writeJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sanitizeHeaders(headers) {
  const next = { ...headers }
  delete next['proxy-connection']
  delete next['proxy-authorization']
  delete next.connection
  return next
}

function createRequestOptions(reqUrl, method, headers) {
  const target = new URL(reqUrl)
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method,
    path: `${target.pathname}${target.search}`,
    headers: sanitizeHeaders(headers),
  }
}

function formatPeer(sock) {
  if (!sock) return 'unknown'
  return `${sock.remoteAddress || 'unknown'}:${sock.remotePort || '0'}`
}

function handleHttpRequest(clientReq, clientRes) {
  if (clientReq.url === '/health') {
    return writeJson(clientRes, 200, {
      ok: true,
      service: 'forward-proxy-test',
      listen: `http://${HOST}:${PORT}`,
      logPath: LOG_PATH,
    })
  }

  let options
  try {
    options = createRequestOptions(clientReq.url, clientReq.method || 'GET', clientReq.headers)
  } catch (e) {
    return writeJson(clientRes, 400, { ok: false, error: 'INVALID_PROXY_URL', message: e.message })
  }

  const transport = options.protocol === 'https:' ? https : http
  log(`HTTP ${options.method} ${options.protocol}//${options.hostname}:${options.port}${options.path} from ${formatPeer(clientReq.socket)}`)

  const upstreamReq = transport.request(options, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
    upstreamRes.pipe(clientRes)
  })

  upstreamReq.setTimeout(TIMEOUT_MS, () => upstreamReq.destroy(new Error('upstream timeout')))
  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      writeJson(clientRes, 502, {
        ok: false,
        error: 'UPSTREAM_REQUEST_FAILED',
        message: err.message,
        targetHost: options.hostname,
        targetPort: options.port,
      })
    } else {
      clientRes.destroy(err)
    }
  })

  clientReq.pipe(upstreamReq)
}

function parseConnectTarget(raw) {
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) return { host: raw, port: 443 }
  return {
    host: raw.slice(0, idx),
    port: Number(raw.slice(idx + 1)) || 443,
  }
}

function handleConnect(req, clientSocket, head) {
  const { host, port } = parseConnectTarget(req.url || '')
  log(`CONNECT ${host}:${port} from ${formatPeer(clientSocket)}`)

  const upstreamSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })

  const destroyBoth = () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    if (!clientSocket.destroyed) clientSocket.destroy()
  }

  upstreamSocket.setTimeout(TIMEOUT_MS)
  upstreamSocket.on('timeout', destroyBoth)
  upstreamSocket.on('error', (err) => {
    log(`CONNECT ERROR ${host}:${port} ${err.message}`)
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    } catch {}
    destroyBoth()
  })
  clientSocket.on('error', destroyBoth)
}

const server = http.createServer(handleHttpRequest)
server.on('connect', handleConnect)
server.on('clientError', (err, socket) => {
  log(`CLIENT ERROR ${err.message}`)
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  } catch {}
})

server.listen(PORT, HOST, () => {
  log(`listening at http://${HOST}:${PORT}`)
})
