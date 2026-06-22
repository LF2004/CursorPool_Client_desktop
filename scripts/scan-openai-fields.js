const fs = require('fs');
const raw = fs.readFileSync(require('path').join(__dirname, '_appuser_dump.json'), 'utf8').replace(/^\uFEFF/, '');
const j = JSON.parse(raw);
function walk(o, path = '', out = []) {
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) {
    const p = path ? `${path}.${k}` : k;
    if (/openai|openAI|byok|override.*url/i.test(k)) {
      out.push([p, typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v]);
    }
    if (v && typeof v === 'object' && path.split('.').length < 5) walk(v, p, out);
  }
  return out;
}
walk(j).forEach(([p, v]) => console.log(p, '=', v));
