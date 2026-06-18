const fs = require('fs');
const path = require('path');

function readSettings() {
  const settingsPath = path.join(__dirname, 'build-settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const s = readSettings();

// 国内网络访问 github.com/electron/electron/releases 常超时，打包前会长时间卡住后失败。
// 默认走 npmmirror；可自行在 build-settings.json 里改 electronMirror，或设环境变量 ELECTRON_MIRROR。
const electronMirror =
    process.env.ELECTRON_MIRROR ||
    s.electronMirror ||
    'https://npmmirror.com/mirrors/electron/';

/**
 * 产物说明（避免只拷贝 win-unpacked 里的 exe）：
 * - win-unpacked/ 里是「绿色目录」：主 exe 必须与同目录的 ffmpeg.dll、libEGL.dll、resources、locales 等一起存在，
 *   单独把 exe 挪到别处运行会报「找不到 ffmpeg.dll」——这是正常现象。
 * - 给用户安装：应使用 npm run build 完全结束后，出现在 dist/ 根目录的「… Setup … .exe」（NSIS 安装包），
 *   用户双击安装后，文件会装到所选目录并带好全部依赖。
 * - 若 dist 根目录没有 Setup.exe：说明 NSIS 步骤未成功（打包被中断或日志末尾有报错），此时只有 win-unpacked。
 * - 临时免安装分发：把整个 win-unpacked 文件夹打成 zip，解压后在内层运行 exe（不要只抽 exe）。
 * - 日志若报 winCodeSign / symbolic link /「客户端没有所需的特权」：为解压签名工具需创建符号链接。
 *   已在 win 里关闭 sign（本地无证书不需要）；仍失败可删除缓存目录后重打：
 *   %LOCALAPPDATA%\\electron-builder\\Cache\\winCodeSign ，或在系统设置中打开「开发者模式」。
 */
module.exports = {
  appId: s.appId || 'com.cursorpool.app',
  productName: s.productName || 'CursorPool',
  // 统一 Windows 默认安装目录/可执行文件名为英文，避免中文路径兼容问题
  executableName: 'CursorRelayLocal',
  /**
   * 安装包文件名。若 dist 下始终生成不出 Setup.exe，可改为纯英文，例如：
   * artifactName: 'XF-CursorPool-Setup-${version}.${ext}',
   */
  artifactName: '${productName} Setup ${version}.${ext}',
  icon: s.logoPath || './assets/icon.ico',
  electronDownload: {
    mirror: electronMirror.endsWith('/') ? electronMirror : `${electronMirror}/`,
  },
  directories: {
    output: 'dist',
  },
  // 不要用单一的 '**'：会把 output 目录 dist/（含 win-unpacked）也打进去，下一版再打包会指数膨胀到几十 GB。
  // 切勿在 desktop/、assets/ 下放置本地数据库或业务大数据；否则会被打进 resources（曾出现整包 50GB+）。
  files: [
    '**/*',
    '!dist/**',
    '!**/dist/**',
    '!**/*.db',
    '!**/*.sqlite',
    '!**/*.sqlite3',
    '!**/*.vscdb',
    '!**/*.db-wal',
    '!**/*.db-shm',
    '!**/axia/**',
    '!**/Axia/**',
  ],
  asar: true,
  /**
   * Windows：NSIS 安装向导（可选安装目录、开始菜单/桌面快捷方式、卸载程序）。
   * 同一 appId 下版本号升高时，线上下载的 Setup + /S 静默安装可覆盖到原目录。
   * win-unpacked/ 仅为构建中间产物，勿分发；给用户的是 dist 根目录的 Setup.exe。
   */
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: s.logoPath || './assets/icon.ico',
    /**
     * 本地未配置代码签名时，避免拉取 winCodeSign 并解压（其中含需 symlink 的 macOS 库），
     * 在多数 Windows 未开「开发者模式」会报错，导致无法生成 NSIS Setup.exe。
     */
    // 需要开启：否则安装后的主程序 exe 可能保留 Electron 默认图标
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    /** 自定义：build/installer.nsh（选目录后自动追加应用子文件夹并 CreateDirectory） */
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    allowElevation: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: s.productName || 'CursorPool',
    runAfterFinish: true,
    /** 控制面板里显示的卸载名称 */
    uninstallDisplayName: s.productName || 'CursorPool',
    installerIcon: s.logoPath || './assets/icon.ico',
    uninstallerIcon: s.logoPath || './assets/icon.ico',
  },
  // Recommended when you load local assets like wallpapers:
  extraResources: [
    {
      from: 'assets',
      to: 'assets',
      // electron-builder will ignore missing files; you can adjust as needed.
    },
  ],
};

