# Auditable Encrypted Notebooks

**Status:** Implemented (v1 format)
**Date:** 2026-03-18 (spec), 2026-03-20 (implementation)
**Author:** Arthur (endarthur), with Claude

**Implementation:** `src/js/crypto.js` (core), `src/js/init.js` (lock screen + UI), `src/js/save.js` (encrypted save path). Tests: `test/crypto.test.mjs`.

## Overview

Whole-notebook encryption for Auditable using Web Crypto (PBKDF2 + AES-GCM). The notebook's data blocks are encrypted as a single blob. The runtime (HTML, CSS, JS) stays cleartext — it's the application. The user's work is opaque without the passphrase.

The browser is the vault. The file is the transport.

```
┌──────────────────────────────────────┐
│  auditable.html (on disk)            │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Auditable runtime (cleartext)  │  │  ← the application
│  │ HTML template, CSS, JS engine  │  │     anyone can see this
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ AUDITABLE-CRYPTO block         │  │  ← salt, params
│  │ (cleartext metadata)           │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Encrypted blob                 │  │  ← cells, settings, modules
│  │ (opaque without passphrase)    │  │     cat/Read/git → gibberish
│  └────────────────────────────────┘  │
│                                      │
└──────────────────────────────────────┘
                    │
                    │ passphrase + browser
                    ▼
┌──────────────────────────────────────┐
│  Browser runtime (memory only)       │
│                                      │
│  Cells, scope, DAG, modules — all    │
│  decrypted, fully functional.        │
│  MCP directives govern live access.  │
│                                      │
└──────────────────────────────────────┘
```

### Goals

- Confine notebook data inside the browser sandbox. The file on disk is opaque.
- Standard Web Crypto only. No external libraries.
- All-or-nothing encryption. The notebook is locked or unlocked, no mixed state.
- Single passphrase entry on load.
- Transparent to everything once unlocked — DAG, MCP, AF, all work normally.
- Works on `file://`, works offline, no external process needed.
- Pre-1.0: format may change, no migration guarantees.

### Non-Goals

- Per-cell encryption granularity. The MCP directive layer handles selective exposure. Encryption handles the file.
- Sharing encrypted notebooks with selective access. If you want to share methodology without data, make a separate notebook.
- Key escrow or external recovery services. A recovery key is generated on encryption setup — the user is responsible for storing it. No cloud backup, no "forgot password" flow.
- Resistance to a compromised browser. If the browser is hostile, nothing in-page helps.

---

## Threat Model

### What This Protects Against

1. **LLM agents reading the file.** Claude Code's `Read` tool, `cat`, any file access. The PreToolUse hook from `@gcu/webmcp` is cooperative guidance; encryption is enforcement.
2. **Git history.** Notebook committed to a repo. The data blocks are opaque in every commit.
3. **Device theft / disk forensics.** Without the passphrase, the data is AES-GCM ciphertext.
4. **Accidental sharing.** Email the notebook, Slack it, put it on a USB stick. Without the passphrase, it's just the Auditable runtime with a lock screen.

### What This Does NOT Protect Against

1. **Compromised browser.** Malicious extensions, XSS — if something can run JS in the page, it can read decrypted memory.
2. **Shoulder surfing / screen capture.** The notebook is visible once unlocked.
3. **Weak passphrases.** PBKDF2 slows brute force but doesn't prevent it.
4. **Memory forensics.** Decrypted data exists in the JS heap.

---

## Cryptographic Design

### Algorithms

- **Key derivation:** PBKDF2, SHA-256, 600,000 iterations, random 16-byte salt.
- **Encryption:** AES-256-GCM, random 12-byte IV per save.
- **All Web Crypto API.** No polyfills, no libraries.
- **Quantum resistant.** The entire chain is symmetric crypto — no public-key math. AES-256 retains 128 bits of security against quantum attacks (Grover's algorithm provides only a quadratic speedup). PBKDF2-SHA256 is similarly unaffected. No post-quantum migration needed. (The Ed25519 notebook *signatures* are a separate concern — those are vulnerable to quantum attacks, but signatures protect integrity, not confidentiality.)

### Flow

```
Encrypt (first time — enabling encryption):
  passphrase → PBKDF2(salt, 600K) → wrapping key
  generate random DEK (AES-256-GCM, extractable) ← once, kept for life of encryption
  wrapKey(DEK, wrapping key, wrapIv) → wrappedDek
  encrypt check value ("auditable-check-v1", checkIv) → check
  serialize(DATA + SETTINGS + MODULES) → plaintext
  AES-GCM(DEK, random payloadIv, plaintext) → ciphertext
  write: CRYPTO block (salt, params, wrappedDek, check) + ciphertext

Encrypt (subsequent saves):
  DEK already in memory from unlock
  serialize(DATA + SETTINGS + MODULES) → plaintext
  AES-GCM(DEK, fresh payloadIv, plaintext) → ciphertext
  re-wrap DEK with each method's wrapping key (fresh wrapIvs)
  write: CRYPTO block + ciphertext

Decrypt (on load):
  read: CRYPTO block → salt, params, wrappedDek
  passphrase → PBKDF2(salt, 600K) → wrapping key
  verify check value → wrong passphrase? reject
  unwrapKey(wrappedDek, wrapping key, wrapIv) → DEK
  AES-GCM(DEK, stored payloadIv, ciphertext) → plaintext
  deserialize → DATA + SETTINGS + MODULES → init notebook
```

The DEK (data encryption key) is a random AES-256 key generated **once** when encryption is first enabled. It is reused for every subsequent save — the payload IV provides freshness (different ciphertext each save). The DEK only changes if the user disables and re-enables encryption. This matters for multi-method: if the DEK were regenerated on every save, every registered WebAuthn method would require a touch on every save to re-wrap. With a stable DEK, re-wrapping uses the wrapping keys already in memory.

Three separate IVs per save:
- **`payloadIv`** (12 bytes): encrypts the data payload with the DEK. Fresh every save.
- **`wrapIv`** (12 bytes, per method): wraps the DEK with each method's wrapping key. Fresh every save.
- **`checkIv`** (12 bytes): encrypts the check value. Fresh every save.

**Why DEK from day one:**
- Adding a second unlock method later (YubiKey, fingerprint) just adds another wrapped copy of the same DEK. No re-encryption of the data, no format migration.
- Changing the passphrase only re-wraps the DEK. Fast regardless of notebook size.
- Web Crypto has native `wrapKey` / `unwrapKey` — no DIY crypto needed.

```js
// Generate DEK
const dek = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
);

// Wrap DEK with passphrase-derived key
const wrappedDek = await crypto.subtle.wrapKey(
  "raw", dek, passphraseKey, { name: "AES-GCM", iv: wrapIv }
);

// Later: unwrap DEK
const dek = await crypto.subtle.unwrapKey(
  "raw", wrappedDek, passphraseKey, { name: "AES-GCM", iv: wrapIv },
  { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
);
```

### Check Value

A known plaintext (`"auditable-check-v1"`) encrypted with the **wrapping key** (not the DEK) using its own dedicated `checkIv`. Stored per-method in the CRYPTO block. On load, decrypt the check value first. If AES-GCM auth tag fails, the passphrase is wrong — fast rejection without attempting to unwrap the DEK or decrypt the payload. The `checkIv` is regenerated on every save alongside all other IVs.

---

## Storage Format

### `AUDITABLE-CRYPTO` Block

New HTML comment block. Replaces `AUDITABLE-DATA`, `AUDITABLE-SETTINGS`, and `AUDITABLE-MODULES` when encryption is enabled.

**Unencrypted notebook (current):**
```html
<!--AUDITABLE-DATA
[...]
AUDITABLE-DATA-->
<!--AUDITABLE-SETTINGS
{...}
AUDITABLE-SETTINGS-->
<!--AUDITABLE-MODULES
base64...
AUDITABLE-MODULES-->
```

**Encrypted notebook:**
```html
<!--AUDITABLE-CRYPTO
{
  "version": 1,
  "cipher": "AES-256-GCM",
  "iv": "base64-12-bytes-payload-iv",
  "payload": "base64-aes-gcm-ciphertext",
  "methods": [
    {
      "type": "pbkdf2",
      "salt": "base64-16-bytes",
      "iterations": 600000,
      "hash": "SHA-256",
      "wrapIv": "base64-12-bytes",
      "wrappedKey": "base64-DEK-wrapped-by-passphrase-key",
      "checkIv": "base64-12-bytes",
      "check": "base64-check-ciphertext"
    },
    {
      "type": "recovery",
      "wrapIv": "base64-12-bytes",
      "wrappedKey": "base64-DEK-wrapped-by-recovery-key",
      "checkIv": "base64-12-bytes",
      "check": "base64-check-ciphertext"
    }
  ]
}
AUDITABLE-CRYPTO-->
```

Every IV in the block is independent and regenerated on every save. The `check` value is encrypted with the method's wrapping key (not the DEK) using its own `checkIv` — this allows passphrase verification before attempting to unwrap the DEK.

The `payload` is encrypted by the DEK. Each entry in `methods` contains a wrapped copy of the same DEK. v1 ships with two methods: passphrase (PBKDF2-derived wrapping key) and recovery key (HKDF-derived wrapping key from random 256-bit key). Adding WebAuthn PRF later is just appending another entry to `methods` — no format version bump, no re-encryption.

### Recovery Key Method

The recovery key is a random 256-bit value generated with `crypto.getRandomValues()`. Unlike the passphrase path, no PBKDF2 is needed — the key is already high entropy. The wrapping key is derived via HKDF-SHA256 with a fixed info string (`"auditable-recovery-v1"`).

Displayed as grouped hex (64 characters, 4-char groups, 2 rows):
```
A7B4 767C DC50 DE62 E962 F5BC 8C7B 03E1
B4DC 03D7 8A81 4D6D F2E9 8132 0A5F 3C71
```

On the lock screen, a "Use recovery key" link expands a text field. Paste or type the hex key, instant decrypt (HKDF is near-instant vs 0.5-2s for PBKDF2).

**Regenerating:** settings panel → "Generate new recovery key." Wraps the DEK with the new key, replaces the recovery method entry. The old key is invalidated. Shows the same modal with copy/download/checkbox.

**Removing:** not recommended, but possible. Deleting the recovery method entry leaves only the passphrase. The settings UI should warn: *"Without a recovery key, a forgotten passphrase means permanent data loss."*

The `payload` plaintext is:

```json
{
  "data": [...],
  "settings": {...},
  "modules": "base64-modules-blob"
}
```

One DEK, one payload encryption. Methods only wrap/unwrap the DEK.

### Encrypted Title

When encryption is enabled, the `<title>` tag is set to `"Auditable \u2014 Encrypted"`. The real notebook title is stored inside the encrypted payload (in the `settings` object). After successful decryption, the `<title>` tag is restored to the real title.

This prevents the notebook title from leaking to file managers, browser tabs, `listNotebooks` (when locked), browser history, and LLM agents scanning file contents.

### Detection

On load, `init()` checks for `AUDITABLE-CRYPTO` before `AUDITABLE-DATA`. If found:
- Check for `crypto.subtle`. If unavailable (ancient browser, non-secure context on some browsers), show an error: "This notebook is encrypted. Your browser does not support the Web Crypto API needed to decrypt it." Do not show the lock screen.
- Otherwise, the notebook is encrypted. Show lock screen. Wait for passphrase (or other registered methods).

If `AUDITABLE-CRYPTO` is not found, load normally (backward compatible).

### Self-Describing Comments

Like existing data blocks, the CRYPTO block gets a descriptive comment above it:

```html
<!-- encrypted notebook data: passphrase required to access cells, settings, and modules -->
<!--AUDITABLE-CRYPTO
...
AUDITABLE-CRYPTO-->
```

---

## UX Flow

### Enabling Encryption

1. User opens settings panel → encryption section.
2. Enters a passphrase (with confirmation field). Strength feedback shown inline (see below).
3. Notebook generates a random DEK, derives a wrapping key from the passphrase via PBKDF2, wraps the DEK.
4. Notebook generates a random 256-bit recovery key, wraps the DEK with it (via HKDF — no PBKDF2 needed, the key is already high entropy).
5. Recovery key displayed as grouped hex:
   ```
   A7B4 767C DC50 DE62 E962 F5BC 8C7B 03E1
   B4DC 03D7 8A81 4D6D F2E9 8132 0A5F 3C71
   ```
   Modal with **Copy** and **Download as .txt** buttons. After copying, a note appears: *"Recovery key copied — clear your clipboard when done."* (Browser security prevents auto-clearing the clipboard without a user gesture.) A checkbox: *"I have saved my recovery key"* — must be ticked before proceeding.
6. Encrypts data blocks with the DEK. Replaces `DATA`/`SETTINGS`/`MODULES` with `CRYPTO` block containing the `methods` array (passphrase entry + recovery entry) and encrypted payload.
7. Next save writes the encrypted format. **All subsequent saves use encryption** until explicitly disabled.

### Encryption Status Indicator

When an encrypted notebook is unlocked, the statusbar shows a small open-lock icon (🔓). Clicking it opens encryption settings (change passphrase, regenerate recovery key, add/remove methods, disable encryption). The icon serves as a reminder that the notebook is encrypted — without it, the user might forget and not think twice about exporting or sharing.

### Passphrase Strength Feedback

The passphrase input shows a single-line estimate of brute-force resistance, assuming a well-funded attacker with a GPU cluster (~100,000 PBKDF2 guesses/second):

```
🔴 Weak — minutes to crack
🔴 Weak — hours to crack
🟡 OK — years to crack
🟢 Strong — centuries to crack
```

The estimate is calculated from character-class entropy (length × log2 of character space), divided by attack rate, displayed as human-readable time. It's a rough approximation — it can't know whether the user picked dictionary words or random characters — but the feedback is intuitive.

Below the indicator, a static note: *"Use 4+ random words for a strong passphrase. A recovery key will be generated as backup."*

Don't block weak passphrases. The user might have a legitimate reason (test notebook, temporary encryption, personal risk assessment). Inform, don't gatekeep.

### Loading an Encrypted Notebook

1. HTML loads. Runtime initializes.
2. Parser finds `AUDITABLE-CRYPTO` instead of `AUDITABLE-DATA`.
3. Notebook shows a lock screen: the Auditable UI with no cells. Primary input: passphrase field. Below it: "Use recovery key" expandable link (expands a hex input field). Plus any WebAuthn options if the `methods` array has them.
4. User enters passphrase, or pastes recovery key, or touches security key / uses fingerprint.
5. Key derivation (0.5-2s for PBKDF2 at 600K iterations. Recovery key via HKDF and WebAuthn PRF are near-instant). PBKDF2 should run in a Web Worker to keep the lock screen UI responsive (spinner stays animated). Web Crypto API is available in workers. Post the passphrase + salt to the worker, receive the derived key back.
6. Check value verification.
7. **Wrong:** error message ("Wrong passphrase" or "Invalid recovery key"), prompt again. No attempt limit — PBKDF2 is the throttle for passphrase; recovery keys are high-entropy so brute force is infeasible regardless.
8. **Correct:** unwrap the DEK, decrypt payload, deserialize data/settings/modules, `init()` continues normally. Cells appear, DAG executes, notebook is fully functional.
9. The DEK (`CryptoKey` object) is held in memory for the session (for re-encryption on save).

### Saving

1. Serialize DATA + SETTINGS + MODULES into the payload JSON.
2. Generate a fresh random 12-byte IV.
3. Encrypt the payload with the DEK (held in memory from unlock).
4. Re-wrap the DEK with each method's wrapping key (fresh wrap IVs).
5. Write `AUDITABLE-CRYPTO` block with methods array, payload IV, and ciphertext.
6. **No `AUDITABLE-DATA`, `AUDITABLE-SETTINGS`, or `AUDITABLE-MODULES` blocks** in the output. They're replaced entirely.

Fresh payload IV on every save means identical content produces different ciphertext. Git sees the whole CRYPTO block changed every time. No partial diffs, no structure leakage.

### Disabling Encryption

1. Settings panel → disable encryption.
2. Notebook decrypts (already in memory), converts back to cleartext data blocks.
3. Next save writes unencrypted format. `AUDITABLE-CRYPTO` block is removed.

### Changing Passphrase

1. Enter current passphrase (already unlocked, so this is a confirmation step).
2. Enter new passphrase (with confirmation).
3. Derive new wrapping key from new passphrase + new salt.
4. Re-wrap the DEK with the new wrapping key.
5. Next save writes updated `methods` entry. **The payload is not re-encrypted** — only the DEK wrapper changes.

The salt is regenerated on passphrase change. Fast regardless of notebook size because only a 32-byte key is being re-wrapped.

---

## Interaction with Packed Saves

Packed notebooks gzip the whole HTML, then base64-encode it.

- **Encrypted + packed:** encrypt first, then pack. The CRYPTO block with its base64 ciphertext gets gzipped alongside everything else. Ciphertext doesn't compress well (pseudorandom), so encrypted notebooks pack slightly less efficiently. Acceptable — the overhead is the base64 encoding of the ciphertext (~33%).
- **Unpacking:** standard packed flow (decompress) reveals the encrypted HTML. Then the passphrase prompt appears.

The two features are orthogonal. No special interaction.

---

## Interaction with AF

1. AF opens an encrypted notebook. The lightweight JSON format stores the encrypted payload as-is:

```json
{
  "encrypted": true,
  "crypto": { "version": 1, "salt": "...", "iv": "...", "iterations": 600000, ... },
  "payload": "base64-ciphertext"
}
```

2. AF hydrates the notebook into an iframe with the encrypted payload.
3. The iframe handles decryption. AF never sees the plaintext.
4. MCP bridge, DAG, everything works normally after decryption inside the iframe.

**Passphrase entry happens in the iframe.** AF doesn't handle, see, or store the passphrase.

### Dropping encrypted notebooks into AF

Same as unencrypted: AF extracts the data blocks. For encrypted notebooks, the "data blocks" are the single CRYPTO blob. AF stores it as-is. No decryption needed for AF's purposes — AF manages files, not cell contents.

---

## Interaction with MCP

### Before Decryption (notebook locked)

If the notebook is connected to the bridge but locked:

- `listNotebooks` shows the notebook with `locked: true`.
- `listCells` returns `{ error: "Notebook is encrypted and locked. Enter the passphrase in the notebook to unlock." }`.
- All other cell tools return the same error.
- `getDocumentation` still works (docs are bridge-side, not notebook-side).

The agent detects this and can tell the user: "The notebook is locked. Please enter the passphrase in the browser."

### After Decryption (notebook unlocked)

Everything works normally. MCP directives govern access. The `locked` flag disappears from `listNotebooks`. The encryption is invisible to the bridge layer.

### On Re-Lock (session timeout or manual lock)

When the notebook re-locks (session timeout, manual lock, or page reload):

- The MCP audit log (`_mcpAuditLog`) must be cleared — it contains tool results from the decrypted session that could leak cell contents.
- The `accept all` flag for confirmation dialogs must reset (already happens on disconnect, but re-lock without disconnect needs the same treatment).
- All scope data and cell references held by the adapter are gone (cells disappear on re-lock), so stale tool calls naturally fail.
- The bridge sees `tools_changed` with an empty or locked-only tool set. `notifications/tools/list_changed` fires.

### notebook.fs and Encryption

When the notebook is encrypted, `notebook.fs` entries are part of the encrypted payload — they're inside the `modules` or `data` block that gets encrypted. No separate treatment needed. The fs is opaque at rest, decrypted in memory, governed by `%mcp fs` directives when live.

However, if a future version adds encrypted notebook.fs as a separate feature (encrypting fs independently of the data blocks), the fs tools would need their own lock/unlock state. Deferred.

---

## Interaction with Signature

The Ed25519 signature (`AUDITABLE-SIGNATURE`) signs the HTML content. For encrypted notebooks:

- The signature covers the encrypted ciphertext, not the plaintext.
- Fresh IVs mean every save produces different ciphertext → different signature. This is correct.
- Verification works as usual — you're verifying that the *file* hasn't been tampered with, not the decrypted content.
- A tampered ciphertext will fail both: signature verification (file integrity) and AES-GCM decryption (auth tag).

---

## Interaction with Export App

`doExportApp()` produces a standalone web page from the notebook.

- **Locked notebook:** refuse to export. "Unlock the notebook first."
- **Unlocked notebook:** export the decrypted content. The export is an unencrypted static app — the user chose to export, the data is intentionally leaving the encrypted container.

---

## Security Audit Checklist

Before shipping:

- [ ] DEK generated with `crypto.subtle.generateKey()`, `extractable: true` (needed for `wrapKey`).
- [ ] DEK generated **once** when encryption is enabled, reused across saves. Not regenerated on each save.
- [ ] Wrapping keys (passphrase-derived) created with `extractable: false`.
- [ ] Payload IV generated fresh (`crypto.getRandomValues(new Uint8Array(12))`) on every save.
- [ ] Wrap IVs generated fresh on every save (separate from payload IV).
- [ ] Check IV (`checkIv`) generated fresh on every save (separate from wrap IV and payload IV).
- [ ] Salt generated fresh (16 bytes) when encryption is first enabled and on passphrase change.
- [ ] Check value uses the fixed string `"auditable-check-v1"`, encrypted with the wrapping key (not the DEK), with its own `checkIv`.
- [ ] Passphrase is not retained as a string after key derivation — only the `CryptoKey` objects persist (wrapping key transiently, DEK for the session).
- [ ] AES-GCM auth tag failures produce a generic error, not detailed cryptographic diagnostics.
- [ ] No `AUDITABLE-DATA`, `AUDITABLE-SETTINGS`, or `AUDITABLE-MODULES` blocks coexist with `AUDITABLE-CRYPTO` in the saved file.
- [ ] The `AUDITABLE-CRYPTO` JSON is valid and complete — partial writes (crash during save) should not produce a file with a corrupt crypto block and no cleartext fallback.
- [ ] The old cleartext blocks are not written to disk at any point during the save process — serialize to memory, encrypt, write the crypto block atomically.
- [ ] `wrapKey` / `unwrapKey` use AES-GCM (not AES-KW) so the wrapped DEK has authentication. A tampered `wrappedKey` fails unwrapping.
- [ ] `crypto.subtle` availability checked before showing lock screen. Graceful error if unavailable.
- [ ] Recovery key generated with `crypto.getRandomValues(new Uint8Array(32))`. Not derived, not predictable.
- [ ] Recovery key wrapping uses HKDF-SHA256 (not PBKDF2) with fixed info string `"auditable-recovery-v1"`.
- [ ] Recovery key displayed only once (on generation). Not stored in the notebook. Not recoverable from the crypto block.
- [ ] Recovery key confirmation checkbox required before encryption completes.
- [ ] MCP audit log (`_mcpAuditLog`) cleared on re-lock — prevents leaking decrypted session data.
- [ ] MCP `accept all` flag reset on re-lock.
- [ ] `tools_changed` emitted on lock/unlock transitions so the bridge updates its tool surface.
- [ ] Lock screen does not reveal cell count, cell types, or any structural metadata from the encrypted payload.
- [ ] `<title>` tag set to generic "Auditable \u2014 Encrypted" when encrypted. Real title stored inside payload.
- [ ] Real title restored after successful decryption.
- [ ] Encryption status indicator (lock icon) visible in statusbar when unlocked.

---

## Open Questions

1. **PBKDF2 iteration future-proofing.** 600K is the current OWASP recommendation. Stored in the crypto block, so old notebooks keep working. Should saving auto-upgrade iterations if below the current recommendation? (Derive with old count to verify, re-derive with new count, re-encrypt.) Probably yes — transparent, no user action needed.

2. **Session timeout.** Clear the derived key after N minutes of inactivity? Protects "walked away" scenarios but forces re-entry. Default off, configurable in settings. When triggered, notebook re-locks: cells disappear, lock screen returns, MCP tools return "locked" errors.

3. **Copy/paste from encrypted notebook.** User copies a cell and pastes it into another (unencrypted) notebook. The decrypted content leaves the encrypted container. This is intentional user action — don't prevent it, but maybe flash a subtle indicator ("content from encrypted notebook").

4. **Save atomicity.** A crash during save could leave the file in a bad state (old crypto block removed, new one not yet written). Options: (a) write to a temp file, then rename (atomic on most filesystems); (b) keep the old crypto block until the new one is fully written. For browser-based saves via download or AF, this is less of a concern — the save produces a complete buffer in memory before writing. But for FSAA (File System Access API) writes, atomicity matters.

5. **~~Passphrase strength.~~** Resolved: estimated brute-force time display. No minimum length, no blocking. See **Passphrase Strength Feedback** in UX section.

6. **Export as txt.** `exportAsTxt()` produces a cleartext `///` format file from the decrypted notebook. Same as export app — the user chose to export, the data is intentionally leaving the encrypted container. But should we warn? A subtle "exporting from encrypted notebook" confirmation might be appropriate.

7. **Split view and encryption.** When the notebook is encrypted and the user enters split view, the `///` format text is derived from decrypted cells — it exists in memory only. No special treatment needed. But if the user saves from split view, the round-trip is: `///` text → parse → cells → serialize → encrypt → write. The encryption step uses the same DEK held in memory. Works naturally.

8. **Encrypted notebook title.** The document title is in the `<title>` tag (cleartext HTML, outside the crypto block). An encrypted notebook's title is visible without decryption — `listNotebooks` shows it, the browser tab shows it. Is this acceptable? For most use cases yes. For maximum opacity, the title could be a generic "Encrypted Notebook" with the real title stored inside the encrypted payload and restored after unlock.

---

## Future Extensions

- **Argon2id.** The proper upgrade from PBKDF2 — memory-hard, GPU-resistant. Not in Web Crypto API, would require a WASM implementation (~50KB). Upgrade path: detect `cipher` or a new `kdf` field in the CRYPTO block, derive with Argon2id instead of PBKDF2. When/if Web Crypto adds it, switch to native. Until then, PBKDF2 at 600K is adequate.
- **Per-group passphrases.** Multiple encryption groups (e.g., "data" and "model") with separate passphrases. Different people get different keys.
- **WebAuthn PRF unlock.** Add hardware or platform authenticators as unlock methods. Uses the WebAuthn PRF extension — the authenticator derives a 32-byte secret from its secure element, which becomes a wrapping key via HKDF. The DEK model and `methods` array are already in v1, so adding PRF is just appending a new entry — no format change needed.

  ### Authenticator Types

  The browser's WebAuthn UI presents available options. All use the same API call (`navigator.credentials.get()` with PRF extension):

  | Type | Example | Credential storage | Portable? | PRF support |
  |---|---|---|---|---|
  | **Security key** (roaming) | YubiKey 5 NFC | On the key's secure element | Yes — works on any machine | Chrome, Edge: good. Safari iOS: limited. |
  | **Platform authenticator** | Windows Hello, Touch ID, Face ID | In the device's TPM/Secure Enclave | No — bound to that specific device | Windows 11 recent builds: works. macOS Sequoia 15.4+: works. |
  | **Cross-device** (hybrid) | Phone via QR + Bluetooth | On the phone | Sort of — needs phone nearby | PRF over BLE: unreliable. Not recommended. |

  For Auditable encrypted notebooks:
  - **Platform authenticator** is the daily driver on your main machine. Fingerprint → decrypt. No hardware to carry, no passphrase to type.
  - **Security key** (YubiKey) is the portable option. Works on any machine you plug it into.
  - **Passphrase** is the universal fallback. Works everywhere, no hardware needed.

  ### Adding a WebAuthn Method

  1. User clicks "Add security key" or "Add fingerprint" in the encryption settings.
  2. WebAuthn `create()` with `extensions: { prf: {} }` — browser prompts for the authenticator.
  3. WebAuthn `get()` with PRF salt → 32-byte secret → HKDF → wrapping key.
  4. Unwrap the DEK with an existing method (user is already unlocked).
  5. Re-wrap the DEK with the new WebAuthn-derived wrapping key.
  6. Append new entry to `methods`:

  ```json
  {
    "type": "webauthn-prf",
    "label": "YubiKey 5 NFC",
    "credentialId": "base64...",
    "salt": "base64...",
    "wrapIv": "base64...",
    "wrappedKey": "base64-DEK-wrapped-by-PRF-key"
  }
  ```

  **Removing a method:** Delete the entry from `methods`. If the last method is removed, encryption is disabled.

  **No PBKDF2 needed for PRF path.** The authenticator produces high-entropy key material directly. HKDF (available in Web Crypto) is sufficient — no iterated hashing. Near-instant unlock vs 0.5-2s for passphrase.

  ### Security Considerations for Multi-Method

  - Each `wrappedKey` is independently attackable. The weakest method determines the notebook's effective security. A weak passphrase next to a YubiKey means the attacker just brute-forces the passphrase.
  - **Recommendation:** if using WebAuthn PRF as primary unlock, set a strong recovery passphrase.
  - Platform authenticator credentials die with the device. Factory reset → that method is gone. YubiKey survives.
  - The `label` field is cleartext. Don't put sensitive info in it.

  ### Browser Support

  Chrome and Edge support PRF well. Safari on iOS doesn't support PRF with roaming authenticators (YubiKeys). Firefox support is limited. Treat PRF as progressive enhancement — always offer passphrase as fallback. If `PublicKeyCredential` and PRF are available, show hardware unlock options. If not, passphrase only.

  **Quantum note:** The PRF output goes through HKDF-SHA256 → AES-256-GCM wrapping. Same symmetric chain as the passphrase path. Quantum resistant. The WebAuthn authentication itself uses ECDSA (not quantum resistant), but the PRF secret derivation is HMAC-based (symmetric, quantum resistant). An attacker with a quantum computer could forge the WebAuthn authentication but would still need the physical authenticator's internal secret to derive the PRF output.
- **Encrypted notebook.fs.** Encrypt the embedded filesystem too, not just the data blocks.
- **~~Key rotation via KEK.~~** Addressed by the DEK model in v1. The DEK *is* the data key wrapped by the `methods` array. Passphrase change only re-wraps the DEK. Already built in.
- **Shamir's Secret Sharing.** Split the DEK across N parties, require M to decrypt. For team notebooks where no single person should have full access. Implementation is ~50-80 lines over GF(256) (Lagrange interpolation). The math is from 1979 and battle-tested.

  **Mixed authentication works naturally.** Shamir splits the DEK into shares. Each share is just 32 bytes. How each person protects their share is independent — the same multi-method wrapping model applies per-share:

  ```json
  {
    "sharing": { "scheme": "shamir", "threshold": 3, "total": 5 },
    "shares": [
      {
        "index": 1, "holder": "Alice",
        "methods": [
          { "type": "webauthn-prf", "label": "YubiKey",    "wrappedShare": "..." },
          { "type": "webauthn-prf", "label": "Fingerprint", "wrappedShare": "..." },
          { "type": "pbkdf2",       "label": "Passphrase",  "wrappedShare": "..." }
        ]
      },
      {
        "index": 2, "holder": "Bob",
        "methods": [
          { "type": "webauthn-prf", "label": "YubiKey",    "wrappedShare": "..." }
        ]
      },
      {
        "index": 3, "holder": "Carol",
        "methods": [
          { "type": "pbkdf2",       "label": "Passphrase",  "wrappedShare": "..." }
        ]
      },
      { "index": 4, "holder": "Dave",  "methods": [...] },
      { "index": 5, "holder": "Eve",   "methods": [...] }
    ]
  }
  ```

  Alice has three ways to unlock her share (YubiKey OR fingerprint OR passphrase) — any one recovers the same share at index 1. Shamir sees one share, not three. Bob uses only his YubiKey. Carol uses only a passphrase. Three of them walk up to the notebook, each authenticates with whatever method they registered, Lagrange interpolation reconstructs the DEK. Mixed auth, mixed hardware, same pattern all the way down.

  **It's turtles:** the DEK model wraps one secret with multiple methods. Shamir splits one secret into multiple shares. Each share is wrapped with multiple methods. Same `wrapKey` / `unwrapKey` at every level.
