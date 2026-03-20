import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// Shim for Node.js
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
if (!globalThis.document) {
  Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, querySelectorAll: () => [] }, configurable: true, writable: true });
}
if (!globalThis.window) {
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
}
// navigator may be read-only in newer Node
try { globalThis.navigator = globalThis.navigator || {}; } catch { /* already exists */ }
globalThis.Worker = undefined;

// Dynamic import after shims
const {
  cryptoDetect,
  cryptoUnlock,
  cryptoUnlockRecovery,
  cryptoEnable,
  cryptoDisable,
  cryptoIsEncrypted,
  cryptoIsLocked,
  cryptoBuildBlock,
  cryptoPassphraseStrength,
  _cryptoFormatRecoveryKey,
  _cryptoParseRecoveryKey,
  cryptoChangePassphrase,
  cryptoRegenerateRecovery,
} = await import('../src/js/crypto.js');

describe('crypto detection', () => {
  it('returns found:false for no crypto block', () => {
    const result = cryptoDetect('<div>hello</div>');
    assert.equal(result.found, false);
  });

  it('detects a CRYPTO block', () => {
    const block = JSON.stringify({ version: 1, cipher: 'AES-256-GCM', methods: [] });
    const html = `<!--AUDITABLE-CRYPTO\n${block}\nAUDITABLE-CRYPTO-->`;
    const result = cryptoDetect(html);
    assert.equal(result.found, true);
    assert.equal(result.block.version, 1);
  });

  it('handles invalid JSON', () => {
    const html = `<!--AUDITABLE-CRYPTO\n{invalid\nAUDITABLE-CRYPTO-->`;
    const result = cryptoDetect(html);
    assert.equal(result.found, false);
  });
});

describe('recovery key format', () => {
  it('formats 32 bytes as grouped hex', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    const formatted = _cryptoFormatRecoveryKey(bytes);
    // Should be 2 rows of 8 groups of 4 hex chars
    const lines = formatted.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].trim().split(' ').length, 8);
    assert.equal(lines[1].trim().split(' ').length, 8);
  });

  it('round-trips through format/parse', () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const formatted = _cryptoFormatRecoveryKey(bytes);
    const parsed = _cryptoParseRecoveryKey(formatted);
    assert.deepEqual(parsed, bytes);
  });

  it('rejects invalid hex', () => {
    assert.throws(() => _cryptoParseRecoveryKey('not hex'), /Invalid recovery key format/);
  });

  it('rejects wrong length', () => {
    assert.throws(() => _cryptoParseRecoveryKey('AABB'), /Invalid recovery key format/);
  });
});

describe('passphrase strength', () => {
  it('returns empty for no input', () => {
    const r = cryptoPassphraseStrength('');
    assert.equal(r.level, 0);
  });

  it('rates short password as weak', () => {
    const r = cryptoPassphraseStrength('abc');
    assert.equal(r.level, 1);
  });

  it('rates long mixed password as strong', () => {
    const r = cryptoPassphraseStrength('correct horse battery staple!!!');
    assert.equal(r.level, 3);
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('encrypts and decrypts with passphrase', async () => {
    const passphrase = 'test-passphrase-123!';
    const recoveryHex = await cryptoEnable(passphrase);
    assert.ok(recoveryHex.length > 0);
    assert.ok(cryptoIsEncrypted());

    // Build a crypto block
    const payload = { data: [{ type: 'code', code: 'const x = 42' }], settings: { theme: 'dark' }, modules: null, fs: null, title: 'test' };
    const block = await cryptoBuildBlock(payload);
    assert.ok(block);
    assert.equal(block.version, 1);
    assert.equal(block.cipher, 'AES-256-GCM');
    assert.ok(block.payload);
    assert.ok(block.methods.length >= 2);

    // Disable and unlock with passphrase
    cryptoDisable();
    assert.ok(!cryptoIsEncrypted());

    const decrypted = await cryptoUnlock(passphrase, block);
    assert.deepEqual(decrypted.data, payload.data);
    assert.deepEqual(decrypted.settings, payload.settings);
    assert.equal(decrypted.title, 'test');

    cryptoDisable();
  });

  it('rejects wrong passphrase', async () => {
    const passphrase = 'correct-password';
    await cryptoEnable(passphrase);

    const payload = { data: [], settings: {}, modules: null, fs: null, title: 'test' };
    const block = await cryptoBuildBlock(payload);

    cryptoDisable();

    await assert.rejects(
      () => cryptoUnlock('wrong-password', block),
      /Wrong passphrase/
    );

    cryptoDisable();
  });

  it('round-trips with recovery key', async () => {
    const passphrase = 'test-passphrase-456!';
    const recoveryHex = await cryptoEnable(passphrase);

    const payload = { data: [{ type: 'md', code: '# Hello' }], settings: {}, modules: null, fs: null, title: 'recovery-test' };
    const block = await cryptoBuildBlock(payload);

    cryptoDisable();

    // Parse the formatted recovery key
    const hexClean = recoveryHex.replace(/\s/g, '');
    const decrypted = await cryptoUnlockRecovery(hexClean, block);
    assert.deepEqual(decrypted.data, payload.data);
    assert.equal(decrypted.title, 'recovery-test');

    cryptoDisable();
  });

  it('rejects invalid recovery key', async () => {
    const passphrase = 'test-passphrase-789!';
    await cryptoEnable(passphrase);

    const payload = { data: [], settings: {}, modules: null, fs: null, title: 'test' };
    const block = await cryptoBuildBlock(payload);

    cryptoDisable();

    // Wrong recovery key
    const wrongKey = '0'.repeat(64);
    await assert.rejects(
      () => cryptoUnlockRecovery(wrongKey, block),
      /Invalid recovery key/
    );

    cryptoDisable();
  });
});

describe('fresh IVs', () => {
  it('produces different ciphertext for same payload', async () => {
    await cryptoEnable('fresh-iv-test!');

    const payload = { data: [{ type: 'code', code: 'const x = 1' }], settings: {}, modules: null, fs: null, title: 'test' };
    const block1 = await cryptoBuildBlock(payload);
    const block2 = await cryptoBuildBlock(payload);

    // Different IVs
    assert.notEqual(block1.iv, block2.iv);
    // Different ciphertext
    assert.notEqual(block1.payload, block2.payload);

    cryptoDisable();
  });
});

describe('no cleartext in encrypted output', () => {
  it('does not contain cell content in the crypto block', async () => {
    await cryptoEnable('no-leak-test!');

    const secret = 'THIS_IS_SECRET_DATA_12345';
    const payload = { data: [{ type: 'code', code: secret }], settings: {}, modules: null, fs: null, title: secret };
    const block = await cryptoBuildBlock(payload);
    const json = JSON.stringify(block);

    assert.ok(!json.includes(secret), 'Secret data found in crypto block JSON');

    cryptoDisable();
  });
});

describe('change passphrase', () => {
  it('allows unlock with new passphrase after change', async () => {
    await cryptoEnable('old-pass-123!');

    const payload = { data: [{ type: 'code', code: 'x = 1' }], settings: {}, modules: null, fs: null, title: 'test' };

    await cryptoChangePassphrase('new-pass-456!');
    const block = await cryptoBuildBlock(payload);

    cryptoDisable();

    // Old passphrase should fail
    await assert.rejects(() => cryptoUnlock('old-pass-123!', block), /Wrong passphrase/);

    // New passphrase should work
    const decrypted = await cryptoUnlock('new-pass-456!', block);
    assert.deepEqual(decrypted.data, payload.data);

    cryptoDisable();
  });
});

describe('regenerate recovery key', () => {
  it('invalidates old recovery key after regeneration', async () => {
    const oldRecovery = await cryptoEnable('regen-test-pass!');
    const payload = { data: [], settings: {}, modules: null, fs: null, title: 'test' };

    const newRecovery = await cryptoRegenerateRecovery();
    assert.notEqual(oldRecovery, newRecovery);

    const block = await cryptoBuildBlock(payload);
    cryptoDisable();

    // Old recovery key should fail
    const oldHex = oldRecovery.replace(/\s/g, '');
    await assert.rejects(() => cryptoUnlockRecovery(oldHex, block), /Invalid recovery key/);

    // New recovery key should work
    const newHex = newRecovery.replace(/\s/g, '');
    await cryptoUnlockRecovery(newHex, block);

    cryptoDisable();
  });
});

describe('title masking', () => {
  it('crypto block does not leak real title', async () => {
    await cryptoEnable('title-test!');

    const payload = { data: [], settings: {}, modules: null, fs: null, title: 'My Secret Notebook' };
    const block = await cryptoBuildBlock(payload);
    const json = JSON.stringify(block);

    assert.ok(!json.includes('My Secret Notebook'));

    cryptoDisable();
  });
});
