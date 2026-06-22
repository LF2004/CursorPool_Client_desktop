const fs = require('fs');
const path = require('path');
const { resolveMainJsPath } = require('../paths');

function buildRelayReviewBridgeInjection() {
  return ['C=xs(),', 'I=di(()=>y==="edit"&&a$g(t),[t,y]),R='].join('');
}

const REVIEW_BRIDGE_MARKER = '__cursorPoolRelayReviewBridge_v2';
const REVIEW_BRIDGE_EFFECT_ANCHOR = '},[a,V,t,i]);const Be=di(()=>{';
const VARIANTS = [
  {
    id: 'legacy',
    unpatched: 'const S=lHg(e),E=aym(v),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
    patched: `const S=lHg(e),E=aym(v),${buildRelayReviewBridgeInjection()}`,
  },
  {
    id: 'native-c',
    unpatched: 'const S=lHg(e),E=aym(v),C=xs(),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
    patched: 'const S=lHg(e),E=aym(v),C=xs(),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
  },
];

function findVariant(text) {
  for (const variant of VARIANTS) {
    if (text.includes(variant.unpatched)) return variant;
  }
  return null;
}

const mainJs = resolveMainJsPath();
const wb = path.join(path.dirname(mainJs), 'vs', 'workbench', 'workbench.desktop.main.js');
const patched = fs.readFileSync(wb, 'utf8');
const RESTORE_RE = /\},\[a,V,t,i\]\);[\s\S]*?globalThis\.__cursorPoolRelayReviewBridge(?:_v\d+)?[\s\S]*?const Be=di\(\(\)=>\{/;
const unpatched = patched.replace(RESTORE_RE, REVIEW_BRIDGE_EFFECT_ANCHOR);

const variant = findVariant(unpatched);
console.log('variant:', variant?.id || 'NONE');
console.log('effect anchor:', unpatched.includes(REVIEW_BRIDGE_EFFECT_ANCHOR));

if (!variant) {
  console.error('FAIL: no signature variant');
  process.exit(1);
}

const sigPatched = variant.unpatched === variant.patched
  ? unpatched
  : unpatched.replace(variant.unpatched, variant.patched);

if (!sigPatched.includes(REVIEW_BRIDGE_EFFECT_ANCHOR)) {
  console.error('FAIL: effect anchor missing after signature step');
  process.exit(1);
}

const effectSnippet = `},[a,V,t,i]);Kd(()=>{if(false){}const Be=di(()=>{`;
const injected = sigPatched.replace(
  REVIEW_BRIDGE_EFFECT_ANCHOR,
  effectSnippet,
);

if (injected === sigPatched) {
  console.error('FAIL: effect injection did not apply');
  process.exit(1);
}

console.log('OK: new Cursor signature patch path works');
