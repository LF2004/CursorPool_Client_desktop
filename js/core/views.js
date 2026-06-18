import { $ } from './dom.js';

async function readView(path) {
  return window.electronBridge.readView(path);
}

export async function loadViews() {
  const panelRoot = $('panelSection');

  const [usageHtml, advancedHtml] = await Promise.all([
    readView('html/tab-usage.html'),
    readView('html/tab-advanced.html'),
  ]);

  panelRoot.innerHTML = `${advancedHtml}${usageHtml}`;
}
