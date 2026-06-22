const fs = require('fs');
const path = require('path');
const readline = require('readline');

const pkgPath = path.join(__dirname, '..', 'package.json');

function isSemver(v) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(v || '').trim());
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const current = String(pkg.version || '1.0.0');
  const answer = (await ask(`请输入本次打包版本号（当前 ${current}，例如 1.0.4）：`)).trim();
  if (!answer) {
    console.log('[set-version] 未输入版本号，保留当前版本：', current);
    return;
  }
  if (!isSemver(answer)) {
    console.error('[set-version] 版本号格式不合法，请使用如 1.0.4');
    process.exit(1);
  }
  pkg.version = answer;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log('[set-version] 已更新 package.json version ->', answer);
}

main().catch((e) => {
  console.error('[set-version] 失败：', e?.message || e);
  process.exit(1);
});

