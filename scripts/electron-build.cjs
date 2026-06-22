/**
 * 避免在未开 Windows 开发者模式时，electron-builder 解压 winCodeSign 创建符号链接失败，
 * 导致只有 win-unpacked、没有 NSIS Setup.exe。
 */
process.env.CSC_IDENTITY_AUTO_DISCOVERY = process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false';
// 避免国内网络拉取 winCodeSign 时访问 github 超时
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const extra = process.argv.slice(2);

const r = spawnSync(process.execPath, [cli, '-c', 'electron-builder.config.js', ...extra], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
});

process.exit(r.status === null ? 1 : r.status);
