import { $ } from './dom.js';

const LOCAL_BRANDING = {
  productName: 'Cursor Relay',
  aboutTitle: 'Cursor Relay Local',
  aboutBody: '纯本地版 Cursor Agent 中继工具。通过 MITM 代理拦截 Cursor 与官方后端的 gRPC 流量，将 Agent 对话转发到您自配置的 OpenAI 兼容 API，并在本机执行工具调用。',
  aboutMuted: 'API Key 与调用记录均保存在本机，不依赖任何远程服务端。详见 LOCAL_RELAY.md。',
  logoUrl: './assets/icon.png',
};

/** @param {Record<string, unknown>} data */
export function applyClientBranding(data) {
  const merged = { ...LOCAL_BRANDING, ...(data && typeof data === 'object' ? data : {}) };

  const productName = String(merged.productName || LOCAL_BRANDING.productName);
  const aboutTitle = String(merged.aboutTitle || LOCAL_BRANDING.aboutTitle);
  const aboutBody = String(merged.aboutBody || LOCAL_BRANDING.aboutBody);
  const aboutMuted = String(merged.aboutMuted || LOCAL_BRANDING.aboutMuted);
  const logoUrl = String(merged.logoUrl || LOCAL_BRANDING.logoUrl);

  document.title = productName;
  const t = $('brandTitle');
  if (t) t.textContent = productName;

  const img = $('brandLogoImg');
  if (img) {
    if (logoUrl) {
      img.classList.remove('hidden');
      img.alt = productName;
      img.src = logoUrl;
      img.onerror = () => {
        img.classList.add('hidden');
      };
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
  }

  const at = $('advAboutTitle');
  if (at) at.textContent = aboutTitle;
  const ab = $('advAboutBody');
  if (ab) ab.textContent = aboutBody;
  const am = $('advAboutMuted');
  if (am) am.textContent = aboutMuted;
}

/** 纯本地版：使用内置品牌信息，不请求任何远程接口。 */
export async function loadClientBranding() {
  applyClientBranding(LOCAL_BRANDING);
}
