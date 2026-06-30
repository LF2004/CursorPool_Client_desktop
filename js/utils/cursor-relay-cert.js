const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { execFileSync, spawnSync } = require('child_process');

const CA_SUBJECT = '/CN=CursorPool Relay CA/O=CursorPool/C=US';
const LEAF_CN = 'cursor.sh';
const LEAF_SANS = [
  'cursor.sh',
  '*.cursor.sh',
  'api2.cursor.sh',
  'api3.cursor.sh',
  'api4.cursor.sh',
  'api5.cursor.sh',
  'agent.api5.cursor.sh',
  'agentn.api5.cursor.sh',
  'localhost',
  '127.0.0.1',
  // Cursor 附属服务域名（MITM 证书需要覆盖，否则 ERR_CERT_COMMON_NAME_INVALID）
  'marketplace.cursorapi.com',
  'prod.authentication.cursor.sh',
  'downloads.cursor.com',
  'cursor-cdn.com',
  '*.cursor.com',
  '*.cursorapi.com',
  '*.authentication.cursor.sh',
];
const DYNAMIC_TLS_CONTEXT_CACHE_LIMIT = 256;
const dynamicTlsProviderCache = new Map();

function getRelayDataDir(customRoot) {
  const root = customRoot || path.join(os.homedir(), '.cursorpool', 'relay');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function getRelayCertPaths(customRoot) {
  const dataDir = getRelayDataDir(customRoot);
  return {
    dataDir,
    caCertPath: path.join(dataDir, 'ca.crt'),
    caKeyPath: path.join(dataDir, 'ca.key'),
    leafCertPath: path.join(dataDir, 'leaf.crt'),
    leafKeyPath: path.join(dataDir, 'leaf.key'),
    fullChainCertPath: path.join(dataDir, 'leaf.fullchain.crt'),
    sanConfigPath: path.join(dataDir, 'leaf-san.cnf'),
    caSerialPath: path.join(dataDir, 'ca.srl'),
  };
}

function fileReady(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function resolveOpenSslBinary() {
  const candidates = [
    process.env.OPENSSL_BIN,
    process.env.OPENSSL_PATH,
    'openssl',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return '';
}

function runOpenSsl(args, options = {}) {
  const openssl = resolveOpenSslBinary();
  if (!openssl) {
    throw new Error('OpenSSL was not found. Install OpenSSL or set OPENSSL_BIN.');
  }
  execFileSync(openssl, args, {
    stdio: 'ignore',
    ...options,
  });
}

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derSeq(...items) {
  return der(0x30, Buffer.concat(items.flat().filter(Boolean)));
}

function derSet(...items) {
  return der(0x31, Buffer.concat(items.flat().filter(Boolean)));
}

function derExplicit(tagNo, value) {
  return der(0xa0 + tagNo, value);
}

function derInteger(value) {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = Buffer.from(value);
  } else {
    let number = BigInt(value);
    const out = [];
    if (number === 0n) out.push(0);
    while (number > 0n) {
      out.unshift(Number(number & 0xffn));
      number >>= 8n;
    }
    bytes = Buffer.from(out);
  }
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) {
    bytes = bytes.slice(1);
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function derBoolean(value) {
  return der(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derNull() {
  return der(0x05, Buffer.alloc(0));
}

function derOid(oid) {
  const parts = String(oid).split('.').map((item) => Number(item));
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

function encodeIpSubjectAltName(name) {
  const value = String(name || '').trim();
  if (!value) return Buffer.alloc(0);
  if (net.isIP(value) === 4) {
    const parts = value.split('.').map((item) => Number(item));
    if (parts.length === 4 && parts.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return der(0x87, Buffer.from(parts));
    }
  }
  return Buffer.alloc(0);
}

function derUtf8(value) {
  return der(0x0c, Buffer.from(String(value), 'utf8'));
}

function derPrintable(value) {
  return der(0x13, Buffer.from(String(value), 'ascii'));
}

function derUtcTime(date) {
  const text = [
    String(date.getUTCFullYear() % 100).padStart(2, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
    'Z',
  ].join('');
  return der(0x17, Buffer.from(text, 'ascii'));
}

function derBitString(bytes, unusedBits = 0) {
  return der(0x03, Buffer.concat([Buffer.from([unusedBits]), Buffer.from(bytes)]));
}

function derOctetString(value) {
  return der(0x04, value);
}

function nameDer(attrs) {
  return derSeq(...attrs.map(([oid, value, printable]) => (
    derSet(derSeq(derOid(oid), printable ? derPrintable(value) : derUtf8(value)))
  )));
}

function certPemFromDer(certDer) {
  const body = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function makeExtension(oid, valueDer, critical = false) {
  return derSeq(
    derOid(oid),
    critical ? derBoolean(true) : null,
    derOctetString(valueDer),
  );
}

function makeKeyUsageExtension(bits) {
  let byte = 0;
  let highest = 0;
  bits.forEach((bit) => {
    byte |= 0x80 >> bit;
    highest = Math.max(highest, bit);
  });
  return derBitString(Buffer.from([byte]), 7 - highest);
}

function makeSubjectAltName(names) {
  return derSeq(...names.map((name) => {
    const ipSan = encodeIpSubjectAltName(name);
    if (ipSan.length) return ipSan;
    return der(0x82, Buffer.from(String(name), 'ascii'));
  }));
}

function buildCaNameDer() {
  return nameDer([
    ['2.5.4.6', 'US', true],
    ['2.5.4.10', 'CursorPool', false],
    ['2.5.4.3', 'CursorPool Relay CA', false],
  ]);
}

function buildLeafNameDer(commonName) {
  return nameDer([
    ['2.5.4.6', 'US', true],
    ['2.5.4.10', 'CursorPool', false],
    ['2.5.4.3', commonName, false],
  ]);
}

function normalizeDynamicLeafHost(rawHost) {
  const value = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return '';
  if (value.includes('/') || value.includes('\\') || /\s/.test(value)) return '';
  return value.split(':')[0];
}

function buildDynamicLeafCertPem(host, materials) {
  const normalizedHost = normalizeDynamicLeafHost(host);
  if (!normalizedHost) throw new Error('Dynamic leaf host is empty.');
  const certDer = buildCertificateDer({
    subject: buildLeafNameDer(normalizedHost),
    issuer: buildCaNameDer(),
    publicKeyPem: materials.leafPublicKeyPem,
    issuerPrivateKeyPem: materials.caKeyPem,
    serial: crypto.randomBytes(16),
    days: 825,
    sans: [normalizedHost],
  });
  return certPemFromDer(certDer);
}

function loadDynamicTlsMaterials(paths) {
  return {
    caKeyPem: fs.readFileSync(paths.caKeyPath, 'utf8'),
    leafKeyPem: fs.readFileSync(paths.leafKeyPath, 'utf8'),
    defaultLeafCertPem: fs.readFileSync(paths.leafCertPath, 'utf8'),
    leafPublicKeyPem: crypto.createPublicKey(fs.readFileSync(paths.leafKeyPath, 'utf8')).export({
      type: 'spki',
      format: 'pem',
    }),
  };
}

function createRelayTlsContextProvider(customRoot = '', logger = null) {
  const rootKey = String(customRoot || '');
  const cached = dynamicTlsProviderCache.get(rootKey);
  if (cached) return cached;

  const paths = ensureRelayCertificates(customRoot);
  const materials = loadDynamicTlsMaterials(paths);
  const caName = buildCaNameDer();
  const contexts = new Map();
  const fallbackContext = tls.createSecureContext({
    key: materials.leafKeyPem,
    cert: materials.defaultLeafCertPem,
  });

  function trimDynamicTlsContextCache() {
    while (contexts.size > DYNAMIC_TLS_CONTEXT_CACHE_LIMIT) {
      const oldestKey = contexts.keys().next().value;
      if (!oldestKey) break;
      contexts.delete(oldestKey);
    }
  }

  function getOrCreateSecureContext(servername = '') {
    const host = normalizeDynamicLeafHost(servername);
    if (!host) {
      return { host: '', secureContext: fallbackContext, cacheHit: true, dynamic: false };
    }
    const existing = contexts.get(host);
    if (existing) {
      contexts.delete(host);
      contexts.set(host, existing);
      return { host, secureContext: existing.secureContext, cacheHit: true, dynamic: true };
    }
    const certPem = certPemFromDer(buildCertificateDer({
      subject: buildLeafNameDer(host),
      issuer: caName,
      publicKeyPem: materials.leafPublicKeyPem,
      issuerPrivateKeyPem: materials.caKeyPem,
      serial: crypto.randomBytes(16),
      days: 825,
      sans: [host],
    }));
    const secureContext = tls.createSecureContext({
      key: materials.leafKeyPem,
      cert: certPem,
    });
    const entry = {
      host,
      secureContext,
      certPem,
      createdAt: Date.now(),
    };
    contexts.set(host, entry);
    trimDynamicTlsContextCache();
    logger?.info?.(`tls dynamic leaf issued host=${host} cacheSize=${contexts.size}`);
    return { host, secureContext, cacheHit: false, dynamic: true };
  }

  const provider = {
    paths,
    key: materials.leafKeyPem,
    cert: materials.defaultLeafCertPem,
    fallbackContext,
    getSecureContext(servername = '') {
      return getOrCreateSecureContext(servername);
    },
    SNICallback(servername, callback) {
      try {
        const resolved = getOrCreateSecureContext(servername);
        if (typeof callback === 'function') callback(null, resolved.secureContext);
        return resolved.secureContext;
      } catch (error) {
        logger?.warn?.(`tls dynamic leaf issue failed host=${String(servername || '-')}: ${error.message}`);
        if (typeof callback === 'function') callback(null, fallbackContext);
        return fallbackContext;
      }
    },
    getCacheStats() {
      return {
        size: contexts.size,
        limit: DYNAMIC_TLS_CONTEXT_CACHE_LIMIT,
      };
    },
  };

  dynamicTlsProviderCache.set(rootKey, provider);
  return provider;
}

function buildCertificateDer({
  subject,
  issuer,
  publicKeyPem,
  issuerPrivateKeyPem,
  serial,
  days,
  isCa = false,
  sans = [],
}) {
  const now = Date.now();
  const notBefore = new Date(now - 5 * 60 * 1000);
  const notAfter = new Date(now + Math.max(1, Number(days) || 365) * 24 * 60 * 60 * 1000);
  const signatureAlgorithm = derSeq(derOid('1.2.840.113549.1.1.11'), derNull());
  const publicKeyDer = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const extensions = [
    makeExtension('2.5.29.19', derSeq(derBoolean(isCa)), true),
    makeExtension('2.5.29.15', makeKeyUsageExtension(isCa ? [5, 6] : [0, 2]), true),
  ];
  if (!isCa) {
    extensions.push(makeExtension('2.5.29.37', derSeq(derOid('1.3.6.1.5.5.7.3.1'))));
    extensions.push(makeExtension('2.5.29.17', makeSubjectAltName(sans)));
  }

  const tbs = derSeq(
    derExplicit(0, derInteger(2)),
    derInteger(serial),
    signatureAlgorithm,
    issuer,
    derSeq(derUtcTime(notBefore), derUtcTime(notAfter)),
    subject,
    publicKeyDer,
    derExplicit(3, derSeq(...extensions)),
  );

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(tbs);
  signer.end();
  return derSeq(tbs, signatureAlgorithm, derBitString(signer.sign(issuerPrivateKeyPem)));
}

function generateRelayCertificatesWithNode(paths) {
  const caKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const leafKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const caName = nameDer([
    ['2.5.4.6', 'US', true],
    ['2.5.4.10', 'CursorPool', false],
    ['2.5.4.3', 'CursorPool Relay CA', false],
  ]);
  const leafName = nameDer([
    ['2.5.4.6', 'US', true],
    ['2.5.4.10', 'CursorPool', false],
    ['2.5.4.3', LEAF_CN, false],
  ]);
  const caDer = buildCertificateDer({
    subject: caName,
    issuer: caName,
    publicKeyPem: caKeys.publicKey,
    issuerPrivateKeyPem: caKeys.privateKey,
    serial: crypto.randomBytes(16),
    days: 3650,
    isCa: true,
  });
  const leafDer = buildCertificateDer({
    subject: leafName,
    issuer: caName,
    publicKeyPem: leafKeys.publicKey,
    issuerPrivateKeyPem: caKeys.privateKey,
    serial: crypto.randomBytes(16),
    days: 825,
    sans: LEAF_SANS,
  });

  fs.writeFileSync(paths.caKeyPath, caKeys.privateKey, 'utf8');
  fs.writeFileSync(paths.caCertPath, certPemFromDer(caDer), 'utf8');
  fs.writeFileSync(paths.leafKeyPath, leafKeys.privateKey, 'utf8');
  fs.writeFileSync(paths.leafCertPath, certPemFromDer(leafDer), 'utf8');
}

function writeLeafSanConfig(configPath) {
  const altNames = LEAF_SANS.map((name, index) => `DNS.${index + 1} = ${name}`).join('\n');
  const content = [
    '[req]',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[req_distinguished_name]',
    `CN = ${LEAF_CN}`,
    '',
    '[v3_req]',
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    altNames,
    '',
  ].join('\n');
  fs.writeFileSync(configPath, content, 'utf8');
}

function removeGeneratedHelperFiles(paths) {
  [paths.fullChainCertPath, paths.sanConfigPath, paths.caSerialPath].forEach((filePath) => {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  });
}

function ensureRelayCertificates(customRoot) {
  const paths = getRelayCertPaths(customRoot);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const openssl = resolveOpenSslBinary();

  if (!fileReady(paths.caCertPath) || !fileReady(paths.caKeyPath)) {
    if (!openssl) {
      generateRelayCertificatesWithNode(paths);
    } else {
      runOpenSsl([
        'req',
        '-x509',
        '-newkey', 'rsa:2048',
        '-keyout', paths.caKeyPath,
        '-out', paths.caCertPath,
        '-days', '3650',
        '-nodes',
        '-subj', CA_SUBJECT,
      ]);
    }
  }

  writeLeafSanConfig(paths.sanConfigPath);

  if (!fileReady(paths.leafCertPath) || !fileReady(paths.leafKeyPath)) {
    if (!openssl) {
      generateRelayCertificatesWithNode(paths);
    } else {
      const csrPath = path.join(paths.dataDir, 'leaf.csr');
      runOpenSsl([
        'req',
        '-new',
        '-newkey', 'rsa:2048',
        '-nodes',
        '-keyout', paths.leafKeyPath,
        '-out', csrPath,
        '-config', paths.sanConfigPath,
      ]);
      runOpenSsl([
        'x509',
        '-req',
        '-in', csrPath,
        '-CA', paths.caCertPath,
        '-CAkey', paths.caKeyPath,
        '-CAcreateserial',
        '-CAserial', paths.caSerialPath,
        '-out', paths.leafCertPath,
        '-days', '825',
        '-extensions', 'v3_req',
        '-extfile', paths.sanConfigPath,
      ]);
      try {
        fs.unlinkSync(csrPath);
      } catch {
        /* ignore */
      }
    }
  }

  removeGeneratedHelperFiles(paths);

  return {
    ...paths,
    caReady: fileReady(paths.caCertPath) && fileReady(paths.caKeyPath),
    leafReady: fileReady(paths.leafCertPath) && fileReady(paths.leafKeyPath),
  };
}

function normalizeSha1Thumbprint(value) {
  return String(value || '')
    .replace(/^sha1\s+fingerprint=/i, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();
}

function readCertSha1Thumbprint(certPath) {
  if (!fileReady(certPath)) return '';
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(certPath));
    return normalizeSha1Thumbprint(x509.fingerprint);
  } catch {
    /* fallback to openssl */
  }
  const openssl = resolveOpenSslBinary();
  if (!openssl) return '';
  try {
    const output = execFileSync(openssl, ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha1'], {
      encoding: 'utf8',
    });
    return normalizeSha1Thumbprint(output);
  } catch {
    return '';
  }
}

function listInstalledRelayCas() {
  if (process.platform !== 'win32') return [];
  const script = [
    "$items = @();",
    "Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue |",
    "Where-Object { $_.Subject -like '*CursorPool Relay CA*' -or ($_.Subject -like '*CursorPool*' -and $_.Subject -like '*Relay CA*') } |",
    "ForEach-Object {",
    "  $items += [PSCustomObject]@{",
    "    thumbprint = $_.Thumbprint;",
    "    subject = $_.Subject;",
    "    store = 'CurrentUser\\\\Root';",
    "  }",
    "};",
    "$items | ConvertTo-Json -Compress",
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const raw = String(result.stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => ({
        thumbprint: normalizeSha1Thumbprint(entry?.thumbprint),
        subject: String(entry?.subject || '').trim(),
        store: String(entry?.store || 'CurrentUser\\Root').trim(),
      }))
      .filter((entry) => entry.thumbprint);
  } catch {
    return [];
  }
}

function getRelayCaTrustState(customRoot) {
  const paths = getRelayCertPaths(customRoot);
  const fileThumbprint = readCertSha1Thumbprint(paths.caCertPath);
  const installed = listInstalledRelayCas();
  const matching = Boolean(
    fileThumbprint && installed.some((entry) => entry.thumbprint === fileThumbprint),
  );
  const stale = fileThumbprint
    ? installed.filter((entry) => entry.thumbprint !== fileThumbprint)
    : installed.slice();
  const trustMismatch = !matching && stale.length > 0;
  const hasExtraTrust = matching && stale.length > 0;
  return {
    fileThumbprint,
    installed,
    matching,
    stale,
    hasStaleTrust: stale.length > 0,
    trustMismatch,
    hasExtraTrust,
    hasAnyTrust: installed.length > 0,
  };
}

function removeInstalledRelayCaEntry(entry) {
  const thumbprint = normalizeSha1Thumbprint(entry?.thumbprint || entry);
  if (!thumbprint) {
    return { ok: false, thumbprint: '', message: 'Relay CA thumbprint is missing.' };
  }

  const certutilResult = spawnSync('certutil', ['-delstore', '-user', '-f', 'Root', thumbprint], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (certutilResult.status === 0) {
    return { ok: true, thumbprint, method: 'certutil' };
  }

  const psPath = `Cert:\\CurrentUser\\Root\\${thumbprint}`;
  const psResult = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Remove-Item -LiteralPath '${psPath}' -Force -ErrorAction Stop`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (psResult.status === 0) {
    return { ok: true, thumbprint, method: 'powershell' };
  }

  const stillInstalled = listInstalledRelayCas().some((item) => item.thumbprint === thumbprint);
  if (!stillInstalled) {
    return { ok: true, thumbprint, method: 'verify-missing' };
  }

  const output = String(
    psResult.stderr
    || psResult.stdout
    || certutilResult.stderr
    || certutilResult.stdout
    || '',
  ).trim();
  return {
    ok: false,
    thumbprint,
    method: 'failed',
    message: output || `Failed to remove Relay CA ${thumbprint} from the current-user Root store.`,
  };
}

function removeInstalledRelayCas(entries = null) {
  if (process.platform !== 'win32') {
    return { ok: false, removed: 0, message: 'Automatic CA removal is only supported on Windows.' };
  }
  const targets = Array.isArray(entries) ? entries : listInstalledRelayCas();
  if (!targets.length) {
    return { ok: true, removed: 0, message: 'No Relay CA entries found in the current-user Root store.' };
  }

  let removed = 0;
  const errors = [];
  for (const entry of targets) {
    const result = removeInstalledRelayCaEntry(entry);
    if (result.ok) {
      removed += 1;
    } else {
      errors.push(result.message || `Failed to remove ${entry.thumbprint}`);
    }
  }

  invalidateCaInstallCache();
  const remaining = listInstalledRelayCas();
  const targetThumbprints = new Set(targets.map((entry) => normalizeSha1Thumbprint(entry?.thumbprint || entry)));
  const remainingTargets = remaining.filter((entry) => targetThumbprints.has(entry.thumbprint));
  return {
    ok: remainingTargets.length === 0,
    removed,
    remaining: remainingTargets,
    message: removed
      ? remainingTargets.length
        ? `Removed ${removed} Relay CA entr${removed === 1 ? 'y' : 'ies'}, but ${remainingTargets.length} still remain in the current-user Root store.`
        : `Removed ${removed} Relay CA entr${removed === 1 ? 'y' : 'ies'} from the current-user Root store.`
      : (errors[0] || 'Failed to remove Relay CA from the current-user Root store.'),
  };
}

function isRelayCaInstalled(customRoot) {
  const paths = getRelayCertPaths(customRoot);
  if (!fileReady(paths.caCertPath)) return false;
  if (process.platform !== 'win32') return false;
  return getRelayCaTrustState(customRoot).matching;
}

function installRelayCaCertificate(customRoot) {
  const paths = ensureRelayCertificates(customRoot);
  if (process.platform !== 'win32') {
    return {
      ok: false,
      installed: false,
      caCertPath: paths.caCertPath,
      message: 'Automatic CA install is only supported on Windows. Import ca.crt into your trust store manually.',
    };
  }

  invalidateCaInstallCache();
  const trustState = getRelayCaTrustState(customRoot);
  if (trustState.matching) {
    const removedStale = trustState.hasStaleTrust
      ? removeInstalledRelayCas(trustState.stale)
      : null;
    return {
      ok: true,
      installed: true,
      alreadyInstalled: true,
      removedStale,
      caCertPath: paths.caCertPath,
      message: removedStale?.removed
        ? `Relay CA is already installed. Removed ${removedStale.removed} stale Relay CA entr${removedStale.removed === 1 ? 'y' : 'ies'}.`
        : 'Relay CA is already installed in the current-user Root store.',
    };
  }

  let removedStale = null;
  if (trustState.hasStaleTrust) {
    removedStale = removeInstalledRelayCas(trustState.stale);
    if (!removedStale.ok) {
      const refreshedTrustState = getRelayCaTrustState(customRoot);
      if (refreshedTrustState.trustMismatch) {
        return {
          ok: false,
          installed: false,
          removedStale,
          caCertPath: paths.caCertPath,
          message: removedStale.message || 'Failed to remove stale Relay CA entries before installing the current CA.',
        };
      }
    }
  }

  const result = spawnSync('certutil', ['-addstore', '-user', '-f', 'Root', paths.caCertPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = String(result.stdout || result.stderr || '').trim();
  invalidateCaInstallCache();
  const installed = result.status === 0 || isRelayCaInstalled(customRoot);
  return {
    ok: installed,
    installed,
    removedStale,
    caCertPath: paths.caCertPath,
    message: installed
      ? (removedStale?.removed
        ? `Removed ${removedStale.removed} stale Relay CA entr${removedStale.removed === 1 ? 'y' : 'ies'} and installed the current CA.`
        : 'Relay CA installed into the current-user Root store.')
      : (output || 'Failed to install Relay CA with certutil.'),
  };
}

let caInstallCache = { at: 0, value: false };

function isRelayCaInstalledCached(customRoot) {
  const now = Date.now();
  if (now - caInstallCache.at < 30000) return caInstallCache.value;
  const value = isRelayCaInstalled(customRoot);
  caInstallCache = { at: now, value };
  return value;
}

function invalidateCaInstallCache() {
  caInstallCache = { at: 0, value: false };
}

function getRelayCertStatusReadonly(customRoot) {
  const paths = getRelayCertPaths(customRoot);
  const trustState = getRelayCaTrustState(customRoot);
  const caInstalled = trustState.matching;
  let installHint = '请将 ca.crt 导入当前用户「受信任的根证书」存储，否则 Cursor 可能拒绝 *.cursor.sh 的 MITM TLS。';
  if (caInstalled) {
    installHint = 'MITM 根证书已在本地受信任。';
  } else if (trustState.trustMismatch) {
    installHint = '检测到旧版 Relay 根证书仍受信任，但当前 ca.crt 已变更；请执行「恢复证书」或重新安装根证书。';
  }
  return {
    dataDir: paths.dataDir,
    caCertPath: paths.caCertPath,
    caKeyPath: paths.caKeyPath,
    leafCertPath: paths.leafCertPath,
    leafKeyPath: paths.leafKeyPath,
    fullChainCertPath: paths.fullChainCertPath,
    caReady: fileReady(paths.caCertPath) && fileReady(paths.caKeyPath),
    leafReady: fileReady(paths.leafCertPath) && fileReady(paths.leafKeyPath),
    caInstalled,
    caTrustMatching: caInstalled,
    caTrustStale: trustState.trustMismatch,
    caTrustExtraStale: trustState.hasExtraTrust,
    caTrustNeedsCleanup: trustState.hasStaleTrust,
    caFileThumbprint: trustState.fileThumbprint,
    installHint,
    leafSubject: LEAF_CN,
    leafSans: LEAF_SANS.slice(),
    opensslAvailable: Boolean(resolveOpenSslBinary()),
  };
}

function getRelayCertStatus(customRoot) {
  ensureRelayCertificates(customRoot);
  invalidateCaInstallCache();
  return getRelayCertStatusReadonly(customRoot);
}

function readCertEndDate(certPath) {
  if (!fileReady(certPath)) return '';
  try {
    return new crypto.X509Certificate(fs.readFileSync(certPath)).validTo || '';
  } catch {
    /* fallback to openssl */
  }
  const openssl = resolveOpenSslBinary();
  if (!openssl) return '';
  try {
    const output = execFileSync(openssl, ['x509', '-in', certPath, '-noout', '-enddate'], {
      encoding: 'utf8',
    });
    const match = String(output || '').match(/notAfter=(.+)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function verifyLeafSignedByCa(leafCertPath, caCertPath) {
  if (!fileReady(leafCertPath) || !fileReady(caCertPath)) {
    return { ok: false, message: 'Certificate files are incomplete.' };
  }
  try {
    const leaf = new crypto.X509Certificate(fs.readFileSync(leafCertPath));
    const ca = new crypto.X509Certificate(fs.readFileSync(caCertPath));
    return leaf.verify(ca.publicKey)
      ? { ok: true, message: 'Leaf certificate is signed by the local Relay CA.' }
      : { ok: false, message: 'Leaf certificate is not signed by the local Relay CA.' };
  } catch {
    /* fallback to OpenSSL below */
  }
  const openssl = resolveOpenSslBinary();
  if (!openssl) {
    return { ok: false, message: 'Leaf certificate verification failed and OpenSSL is unavailable.' };
  }
  if (!openssl || !fileReady(leafCertPath) || !fileReady(caCertPath)) {
    return { ok: false, message: '证书文件不完整，无法校验签发关系。' };
  }
  try {
    execFileSync(openssl, ['verify', '-CAfile', caCertPath, leafCertPath], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, message: 'Leaf 证书由本地 CA 正确签发。' };
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').trim();
    return {
      ok: false,
      message: detail || 'Leaf 证书未能通过 CA 校验。',
    };
  }
}

function resetRelayCertificateFiles(customRoot) {
  const paths = getRelayCertPaths(customRoot);
  const fileNames = [
    'ca.crt',
    'ca.key',
    'leaf.crt',
    'leaf.key',
    'leaf.fullchain.crt',
    'leaf-san.cnf',
    'ca.srl',
    'leaf.csr',
  ];
  let removed = 0;
  for (const fileName of fileNames) {
    const target = path.join(paths.dataDir, fileName);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return { removed, dataDir: paths.dataDir };
}

function repairRelayCertificates(customRoot) {
  invalidateCaInstallCache();
  const trustBefore = getRelayCaTrustState(customRoot);
  const removedFromStore = removeInstalledRelayCas(trustBefore.installed);
  const removedFiles = resetRelayCertificateFiles(customRoot);
  const paths = ensureRelayCertificates(customRoot);
  const install = installRelayCaCertificate(customRoot);
  invalidateCaInstallCache();
  const check = checkRelayCertificates(customRoot);
  return {
    ok: Boolean(install.installed && check.readyForMitm && !check.caTrustStale),
    regenerated: true,
    removedFromStore,
    removedFiles,
    install,
    check,
    caCertPath: paths.caCertPath,
    message: check.readyForMitm
      ? 'Relay 证书已重新生成，并已同步安装到本地受信任存储。请重新启用 Relay 以加载新证书。'
      : (install.message || check.summary || 'Relay 证书恢复未完成，请查看检查结果。'),
  };
}

function checkRelayCertificates(customRoot) {
  const paths = ensureRelayCertificates(customRoot);
  const trustState = getRelayCaTrustState(customRoot);
  const caInstalled = trustState.matching;
  const leafVerify = verifyLeafSignedByCa(paths.leafCertPath, paths.caCertPath);
  const caExpiresAt = readCertEndDate(paths.caCertPath);
  const leafExpiresAt = readCertEndDate(paths.leafCertPath);

  const checks = [
    {
      id: 'ca_file',
      label: 'CA 证书文件',
      ok: paths.caReady,
      detail: paths.caReady ? paths.caCertPath : '未生成 ca.crt',
    },
    {
      id: 'leaf_file',
      label: 'Leaf 证书文件',
      ok: paths.leafReady,
      detail: paths.leafReady ? paths.leafCertPath : '未生成 leaf.crt',
    },
    {
      id: 'leaf_chain',
      label: 'Leaf 签发链',
      ok: leafVerify.ok,
      detail: leafVerify.message,
    },
    {
      id: 'ca_trust',
      label: '根证书信任',
      ok: caInstalled,
      detail: caInstalled
        ? '当前 ca.crt 已安装到当前用户 Root 存储'
        : trustState.trustMismatch
          ? `检测到 ${trustState.stale.length} 个旧版 Relay 根证书仍受信任，但与当前 ca.crt 指纹不一致`
          : '尚未安装到受信任的根证书存储',
    },
    {
      id: 'openssl',
      label: 'OpenSSL 可用',
      ok: Boolean(resolveOpenSslBinary()),
      detail: resolveOpenSslBinary() ? '可用于证书校验' : '未找到 OpenSSL，部分校验受限',
    },
  ];

  const opensslCheck = checks.find((item) => item.id === 'openssl');
  if (opensslCheck) {
    opensslCheck.label = 'OpenSSL optional';
    opensslCheck.ok = true;
    opensslCheck.detail = resolveOpenSslBinary()
      ? 'OpenSSL is available, but not required.'
      : 'OpenSSL is not installed. Using Electron built-in Node crypto instead.';
  }

  const passed = checks.filter((item) => item.ok).length;
  const ok = checks.every((item) => item.id === 'openssl' ? true : item.ok);
  const readyForMitm = paths.caReady && paths.leafReady && leafVerify.ok && caInstalled;

  let summary = '证书检查未通过，请重新启用 Relay 或手动导入 ca.crt。';
  if (readyForMitm) {
    summary = '证书检查通过：MITM 所需 CA/Leaf 已就绪，且根证书已在本地受信任。';
  } else if (trustState.trustMismatch) {
    summary = '证书文件已就绪，但本地仍信任旧版 Relay 根证书；MITM 会失败，请执行「恢复证书」。';
  } else if (ok) {
    summary = '证书文件正常，但根证书尚未完全受信任，Cursor 可能仍报 TLS 错误。';
  }

  return {
    ok,
    readyForMitm,
    passed,
    total: checks.length,
    checks,
    caCertPath: paths.caCertPath,
    leafCertPath: paths.leafCertPath,
    fullChainCertPath: paths.fullChainCertPath,
    caExpiresAt,
    leafExpiresAt,
    caInstalled,
    caTrustStale: trustState.trustMismatch,
    caTrustExtraStale: trustState.hasExtraTrust,
    caTrustNeedsCleanup: trustState.hasStaleTrust,
    caTrustMatching: caInstalled,
    needsRepair: trustState.trustMismatch,
    summary,
  };
}

module.exports = {
  getRelayDataDir,
  getRelayCertPaths,
  ensureRelayCertificates,
  createRelayTlsContextProvider,
  getRelayCertStatus,
  getRelayCertStatusReadonly,
  installRelayCaCertificate,
  isRelayCaInstalled,
  checkRelayCertificates,
  repairRelayCertificates,
  getRelayCaTrustState,
  removeInstalledRelayCas,
  resetRelayCertificateFiles,
  invalidateCaInstallCache,
};
