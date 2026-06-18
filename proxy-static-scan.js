#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const TARGETS = [
  path.join(ROOT, 'main.js'),
  path.join(ROOT, 'preload.js'),
  path.join(ROOT, 'js', 'utils', 'cursor-model-proxy.js'),
  path.join(ROOT, 'js', 'modules', 'proxy.js'),
]

const CHECKS = [
  { name: 'HTTP server', patterns: [/createServer\(/, /http\.createServer\(/, /https\.createServer\(/] },
  { name: 'listen port', patterns: [/\.listen\(/, /9182/, /8787/] },
  { name: 'HTTPS CONNECT tunnel', patterns: [/\bCONNECT\b/, /on\(['"]connect['"]/, /net\.connect\(/] },
  { name: 'Electron setProxy', patterns: [/session\.setProxy\(/, /defaultSession\.setProxy\(/] },
  { name: 'System/Root CA', patterns: [/Root CA/i, /certificate/i, /certutil/i, /NODE_EXTRA_CA_CERTS/, /setCertificateVerifyProc/] },
  { name: 'BYOK state.vscdb write', patterns: [/cursorAuth\/openAIKey/, /openAIBaseUrl/, /useOpenAIKey/, /state\.vscdb/] },
]

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function matchAll(text, patterns) {
  return patterns.some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)))
}

function main() {
  const bundle = TARGETS.map((f) => `\n// FILE: ${f}\n${read(f)}`).join('\n')
  console.log('======== 静态代理能力扫描 ========')
  for (const check of CHECKS) {
    console.log(`${check.name}: ${matchAll(bundle, check.patterns) ? 'YES' : 'NO'}`)
  }
  console.log('=================================')
}

main()
