#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { readModelProxyConfig } = require('./js/utils/cursor-model-proxy')

const ROOT = __dirname
const MAIN_JS = path.join(ROOT, 'main.js')
const PRELOAD_JS = path.join(ROOT, 'preload.js')
const PROXY_UTIL = path.join(ROOT, 'js', 'utils', 'cursor-model-proxy.js')

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function yesno(v) {
  return v ? 'YES' : 'NO'
}

function hasAny(text, patterns) {
  return patterns.some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)))
}

async function main() {
  const mainText = read(MAIN_JS)
  const preloadText = read(PRELOAD_JS)
  const proxyUtilText = read(PROXY_UTIL)

  const cfg = await readModelProxyConfig().catch((e) => ({ ok: false, error: e.message || String(e) }))

  const hasByokWrite = hasAny(proxyUtilText, [
    'cursorAuth/openAIKey',
    'openAIBaseUrl',
    'useOpenAIKey',
    'writeModelProxyConfig',
  ])

  const hasLocalProxyServer = hasAny(mainText + '\n' + preloadText + '\n' + proxyUtilText, [
    /createServer\(/,
    /server\.listen\(/,
    /CONNECT/,
    /session\.setProxy/,
    /http\.proxy/,
    /proxy server started/i,
    /Root CA/i,
    /certificate/i,
    /9182/,
  ])

  const hasBridgeMethods = hasAny(preloadText, [
    'proxyModelGetConfig',
    'proxyModelApply',
    'proxyModelDisable',
    'proxyModelTest',
  ])

  console.log('======== CursorPool Electron 代理诊断 ========')
  console.log('[1] BYOK 配置读取')
  if (!cfg || cfg.ok === false) {
    console.log('  - 读取失败 =', cfg?.error || 'unknown')
  } else {
    console.log('  - state.vscdb exists =', yesno(cfg.dbExists))
    console.log('  - cursorRunning      =', yesno(cfg.cursorRunning))
    console.log('  - enabled            =', yesno(cfg.config?.enabled))
    console.log('  - useOpenAIKey       =', yesno(cfg.config?.useOpenAIKey))
    console.log('  - baseUrl            =', cfg.config?.baseUrl || '(empty)')
    console.log('  - providerId         =', cfg.config?.providerId || '(unknown)')
    console.log('  - apiKeySaved        =', yesno(Boolean(cfg.config?.apiKey)))
    console.log('  - configSynced       =', yesno(cfg.config?.configSynced !== false))
  }

  console.log('')
  console.log('[2] 实现能力判定')
  console.log('  - hasBridgeMethods   =', yesno(hasBridgeMethods))
  console.log('  - hasByokWrite       =', yesno(hasByokWrite))
  console.log('  - hasLocalProxyImpl  =', yesno(hasLocalProxyServer))

  console.log('')
  console.log('[3] 结论')
  if (hasByokWrite && !hasLocalProxyServer) {
    console.log('  - 当前实现更像：BYOK / OpenAI 兼容端点写入器')
    console.log('  - 当前实现不像：本地代理接管 Cursor 官方请求')
    console.log('  - 因此：如果你仍在 Cursor 里使用 Auto/Composer，依然会命中官方套餐限制')
  } else if (hasLocalProxyServer) {
    console.log('  - 代码中检测到本地代理相关实现，请继续排查监听端口和请求流向')
  } else {
    console.log('  - 当前代码里未检测到足够的代理能力特征')
  }

  console.log('=============================================')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
