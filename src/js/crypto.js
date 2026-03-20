// ── ENCRYPTION ──
// AES-256-GCM whole-notebook encryption via Web Crypto API.
// All functions prefixed _crypto for IIFE build.

// No imports from other modules — crypto.js is a pure crypto module.
// UI interactions are wired in init.js.

// ── State ──

let _cryptoState = null; // null = unencrypted, or { dek, methods }
let _cryptoLocked = false; // true when CRYPTO block detected but DEK not yet available

export function cryptoIsEncrypted() { return _cryptoState !== null; }
export function cryptoIsLocked() { return _cryptoLocked; }

// ── Base64 helpers ──

function _cryptoB64Encode(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function _cryptoB64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Recovery key formatting ──

export function _cryptoFormatRecoveryKey(bytes) {
  const arr = new Uint8Array(bytes);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0').toUpperCase();
  // group into 4-char chunks, 8 groups per row
  const groups = hex.match(/.{4}/g);
  return groups.slice(0, 8).join(' ') + '\n' + groups.slice(8).join(' ');
}

export function _cryptoParseRecoveryKey(hex) {
  const clean = hex.replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('Invalid recovery key format');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

// ── PBKDF2 key derivation (in Web Worker to keep UI responsive) ──

function _cryptoDeriveKeyWorker(passphrase, salt, iterations) {
  // In Node.js test environment, fall back to sync
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return _cryptoDeriveKeySync(passphrase, salt, iterations);
  }

  return new Promise((resolve, reject) => {
    const code = `self.onmessage = async ({data}) => {
  try {
    const enc = new TextEncoder().encode(data.passphrase);
    const baseKey = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      {name: 'PBKDF2', salt: new Uint8Array(data.salt), iterations: data.iterations, hash: 'SHA-256'},
      baseKey,
      {name: 'AES-GCM', length: 256},
      true,
      ['encrypt', 'decrypt']
    );
    // Export key bits to transfer back (extractable in worker, re-imported as non-extractable in main)
    const raw = await crypto.subtle.exportKey('raw', key);
    self.postMessage({raw: raw}, [raw]);
  } catch (e) {
    self.postMessage({error: e.message});
  }
};`;

    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    worker.onmessage = async ({ data }) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      if (data.error) { reject(new Error(data.error)); return; }
      // Re-import as non-extractable CryptoKey
      try {
        const key = await crypto.subtle.importKey(
          'raw', data.raw, { name: 'AES-GCM' }, false,
          ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
        );
        resolve(key);
      } catch (e) { reject(e); }
    };
    worker.onerror = (e) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error('Worker error: ' + e.message));
    };

    worker.postMessage({
      passphrase,
      salt: Array.from(new Uint8Array(salt)),
      iterations,
    });
  });
}

async function _cryptoDeriveKeySync(passphrase, salt, iterations) {
  const enc = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
  );
}

// ── HKDF for recovery key ──

async function _cryptoDeriveRecoveryKey(rawBytes) {
  const base = await crypto.subtle.importKey('raw', rawBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('auditable-recovery-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
  );
}

// ── Check value ──

const _CRYPTO_CHECK_PLAINTEXT = 'auditable-check-v1';

async function _cryptoEncryptCheck(wrappingKey) {
  const checkIv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(_CRYPTO_CHECK_PLAINTEXT);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: checkIv }, wrappingKey, plaintext
  );
  return { checkIv, check: ciphertext };
}

async function _cryptoVerifyCheck(wrappingKey, checkIv, check) {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(checkIv) }, wrappingKey, check
    );
    const text = new TextDecoder().decode(plain);
    return text === _CRYPTO_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// ── DEK wrap/unwrap ──

async function _cryptoWrapDek(dek, wrappingKey) {
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('raw', dek, wrappingKey, { name: 'AES-GCM', iv: wrapIv });
  return { wrapIv, wrappedKey: wrapped };
}

async function _cryptoUnwrapDek(wrappedKey, wrappingKey, wrapIv) {
  return crypto.subtle.unwrapKey(
    'raw', wrappedKey, wrappingKey, { name: 'AES-GCM', iv: new Uint8Array(wrapIv) },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

// ── Payload encrypt/decrypt ──

async function _cryptoEncryptPayload(dek, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, encoded);
  return { iv, payload: ciphertext };
}

async function _cryptoDecryptPayload(dek, iv, ciphertext) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, dek, ciphertext);
  return new TextDecoder().decode(plain);
}

// ── CRYPTO block detection ──

export function cryptoDetect(bodyHtml) {
  const match = bodyHtml.match(/<!--AUDITABLE-CRYPTO\n([\s\S]*?)\nAUDITABLE-CRYPTO-->/);
  if (!match) return { found: false };
  try {
    return { found: true, block: JSON.parse(match[1]) };
  } catch {
    return { found: false, error: 'Invalid CRYPTO block JSON' };
  }
}

// ── Unlock with passphrase ──

export async function cryptoUnlock(passphrase, block) {
  const method = block.methods.find(m => m.type === 'pbkdf2');
  if (!method) throw new Error('No passphrase method in crypto block');

  const salt = _cryptoB64Decode(method.salt);
  const wrappingKey = await _cryptoDeriveKeyWorker(passphrase, salt, method.iterations);

  // Verify check value
  const checkIv = _cryptoB64Decode(method.checkIv);
  const check = _cryptoB64Decode(method.check);
  const valid = await _cryptoVerifyCheck(wrappingKey, checkIv, check);
  if (!valid) throw new Error('Wrong passphrase');

  // Unwrap DEK
  const wrappedKey = _cryptoB64Decode(method.wrappedKey);
  const wrapIv = _cryptoB64Decode(method.wrapIv);
  const dek = await _cryptoUnwrapDek(wrappedKey, wrappingKey, wrapIv);

  // Decrypt payload
  const iv = _cryptoB64Decode(block.iv);
  const payload = _cryptoB64Decode(block.payload);
  const plaintext = await _cryptoDecryptPayload(dek, iv, payload);
  const data = JSON.parse(plaintext);

  // Store state with method metadata (needed for re-wrapping)
  _cryptoState = {
    dek,
    methods: block.methods.map(m => {
      if (m.type === 'pbkdf2') {
        return { type: 'pbkdf2', salt: new Uint8Array(salt), iterations: m.iterations, wrappingKey };
      }
      if (m.type === 'recovery') {
        return { type: 'recovery', wrappingKey: null }; // no wrapping key until recovery used
      }
      return m;
    }),
  };
  _cryptoLocked = false;

  return data;
}

// ── Unlock with recovery key ──

export async function cryptoUnlockRecovery(hexKey, block) {
  const rawBytes = _cryptoParseRecoveryKey(hexKey);
  const method = block.methods.find(m => m.type === 'recovery');
  if (!method) throw new Error('No recovery method in crypto block');

  const wrappingKey = await _cryptoDeriveRecoveryKey(rawBytes);

  // Verify check value
  const checkIv = _cryptoB64Decode(method.checkIv);
  const check = _cryptoB64Decode(method.check);
  const valid = await _cryptoVerifyCheck(wrappingKey, checkIv, check);
  if (!valid) throw new Error('Invalid recovery key');

  // Unwrap DEK
  const wrappedKey = _cryptoB64Decode(method.wrappedKey);
  const wrapIv = _cryptoB64Decode(method.wrapIv);
  const dek = await _cryptoUnwrapDek(wrappedKey, wrappingKey, wrapIv);

  // Decrypt payload
  const iv = _cryptoB64Decode(block.iv);
  const payload = _cryptoB64Decode(block.payload);
  const plaintext = await _cryptoDecryptPayload(dek, iv, payload);
  const data = JSON.parse(plaintext);

  // Store state — we have recovery wrapping key but not passphrase wrapping key
  _cryptoState = {
    dek,
    methods: block.methods.map(m => {
      if (m.type === 'pbkdf2') {
        return { type: 'pbkdf2', salt: _cryptoB64Decode(m.salt), iterations: m.iterations, wrappingKey: null };
      }
      if (m.type === 'recovery') {
        return { type: 'recovery', wrappingKey };
      }
      return m;
    }),
  };
  _cryptoLocked = false;

  return data;
}

// ── Enable encryption ──

export async function cryptoEnable(passphrase) {
  // Generate DEK (extractable — needed for wrapKey)
  const dek = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );

  // Passphrase method
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await _cryptoDeriveKeyWorker(passphrase, salt, 600000);

  // Recovery key method
  const recoveryRaw = crypto.getRandomValues(new Uint8Array(32));
  const recoveryWrappingKey = await _cryptoDeriveRecoveryKey(recoveryRaw);

  _cryptoState = {
    dek,
    methods: [
      { type: 'pbkdf2', salt, iterations: 600000, wrappingKey },
      { type: 'recovery', wrappingKey: recoveryWrappingKey },
    ],
  };

  return _cryptoFormatRecoveryKey(recoveryRaw);
}

// ── Disable encryption ──

export function cryptoDisable() {
  _cryptoState = null;
  _cryptoLocked = false;
}

// ── Change passphrase ──

export async function cryptoChangePassphrase(newPassphrase) {
  if (!_cryptoState) throw new Error('Not encrypted');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await _cryptoDeriveKeyWorker(newPassphrase, salt, 600000);

  const pbkdf2 = _cryptoState.methods.find(m => m.type === 'pbkdf2');
  if (pbkdf2) {
    pbkdf2.salt = salt;
    pbkdf2.iterations = 600000;
    pbkdf2.wrappingKey = wrappingKey;
  }
}

// ── Regenerate recovery key ──

export async function cryptoRegenerateRecovery() {
  if (!_cryptoState) throw new Error('Not encrypted');
  const recoveryRaw = crypto.getRandomValues(new Uint8Array(32));
  const recoveryWrappingKey = await _cryptoDeriveRecoveryKey(recoveryRaw);

  const recovery = _cryptoState.methods.find(m => m.type === 'recovery');
  if (recovery) {
    recovery.wrappingKey = recoveryWrappingKey;
  } else {
    _cryptoState.methods.push({ type: 'recovery', wrappingKey: recoveryWrappingKey });
  }

  return _cryptoFormatRecoveryKey(recoveryRaw);
}

// ── Build CRYPTO block for save ──

export async function cryptoBuildBlock(payload) {
  if (!_cryptoState) return null;

  // Encrypt payload
  const plaintext = JSON.stringify(payload);
  const { iv, payload: ciphertext } = await _cryptoEncryptPayload(_cryptoState.dek, plaintext);

  // Build methods array with fresh IVs
  const methods = [];
  for (const m of _cryptoState.methods) {
    if (m.type === 'pbkdf2' && m.wrappingKey) {
      const { wrapIv, wrappedKey } = await _cryptoWrapDek(_cryptoState.dek, m.wrappingKey);
      const { checkIv, check } = await _cryptoEncryptCheck(m.wrappingKey);
      methods.push({
        type: 'pbkdf2',
        salt: _cryptoB64Encode(m.salt),
        iterations: m.iterations,
        hash: 'SHA-256',
        wrapIv: _cryptoB64Encode(wrapIv),
        wrappedKey: _cryptoB64Encode(wrappedKey),
        checkIv: _cryptoB64Encode(checkIv),
        check: _cryptoB64Encode(check),
      });
    } else if (m.type === 'recovery' && m.wrappingKey) {
      const { wrapIv, wrappedKey } = await _cryptoWrapDek(_cryptoState.dek, m.wrappingKey);
      const { checkIv, check } = await _cryptoEncryptCheck(m.wrappingKey);
      methods.push({
        type: 'recovery',
        wrapIv: _cryptoB64Encode(wrapIv),
        wrappedKey: _cryptoB64Encode(wrappedKey),
        checkIv: _cryptoB64Encode(checkIv),
        check: _cryptoB64Encode(check),
      });
    }
  }

  const block = {
    version: 1,
    cipher: 'AES-256-GCM',
    iv: _cryptoB64Encode(iv),
    payload: _cryptoB64Encode(ciphertext),
    methods,
  };

  return block;
}

// ── Lock (clear keys from memory) ──

export function cryptoLock() {
  if (!_cryptoState) return;
  _cryptoState = null;
  _cryptoLocked = true;

  // Notify MCP if available
  if (typeof window !== 'undefined' && window._mcpOnRelock) {
    window._mcpOnRelock();
  }
}

// ── Set locked flag (used during init when CRYPTO block found) ──

export function cryptoSetLocked(locked) {
  _cryptoLocked = locked;
}

// ── Passphrase strength ──

export function cryptoPassphraseStrength(passphrase) {
  if (!passphrase) return { level: 0, label: '' };
  const len = passphrase.length;
  let charSpace = 0;
  if (/[a-z]/.test(passphrase)) charSpace += 26;
  if (/[A-Z]/.test(passphrase)) charSpace += 26;
  if (/[0-9]/.test(passphrase)) charSpace += 10;
  if (/[^a-zA-Z0-9]/.test(passphrase)) charSpace += 32;
  if (charSpace === 0) charSpace = 26;

  const entropy = len * Math.log2(charSpace);
  // assume 100,000 guesses/sec (GPU cluster with PBKDF2 600K)
  const seconds = Math.pow(2, entropy) / 100000;

  if (seconds < 3600) return { level: 1, label: 'weak \u2014 minutes to crack' };
  if (seconds < 86400 * 365) return { level: 1, label: 'weak \u2014 hours to crack' };
  if (seconds < 86400 * 365 * 100) return { level: 2, label: 'ok \u2014 years to crack' };
  return { level: 3, label: 'strong \u2014 centuries to crack' };
}

// ── Live sync for encrypted notebooks ──

let _cryptoNode = null;
let _cryptoSyncTimer = null;

export function initCryptoSync() {
  // Find or create the CRYPTO comment node
  const iter = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  let node;
  while ((node = iter.nextNode())) {
    if (node.nodeValue.startsWith('AUDITABLE-CRYPTO\n')) { _cryptoNode = node; return; }
  }
  // Create if not found
  const desc = document.createComment(' encrypted notebook data: passphrase required to access cells, settings, and modules ');
  document.body.appendChild(desc);
  _cryptoNode = document.createComment('AUDITABLE-CRYPTO\n\nAUDITABLE-CRYPTO');
  document.body.appendChild(_cryptoNode);
}

export async function syncCrypto(payload) {
  if (!_cryptoNode || !_cryptoState) return;
  try {
    const block = await cryptoBuildBlock(payload);
    if (block) {
      _cryptoNode.nodeValue = 'AUDITABLE-CRYPTO\n' + JSON.stringify(block) + '\nAUDITABLE-CRYPTO';
    }
  } catch (e) {
    console.error('crypto sync error:', e);
  }
}

export function syncCryptoDebounced(payload) {
  clearTimeout(_cryptoSyncTimer);
  _cryptoSyncTimer = setTimeout(() => syncCrypto(payload), 500);
}

// ── Remove cleartext data comment nodes ──

export function removeCleartextNodes() {
  const tags = ['AUDITABLE-DATA', 'AUDITABLE-SETTINGS', 'AUDITABLE-MODULES', 'AUDITABLE-FS'];
  const iter = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  const toRemove = [];
  let node;
  while ((node = iter.nextNode())) {
    for (const tag of tags) {
      if (node.nodeValue.startsWith(tag + '\n')) {
        // Also remove description comment before it
        if (node.previousSibling?.nodeType === 8) toRemove.push(node.previousSibling);
        toRemove.push(node);
        break;
      }
    }
  }
  for (const n of toRemove) n.remove();
}
