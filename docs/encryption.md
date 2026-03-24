# Encryption

Auditable supports whole-notebook encryption using AES-256-GCM via the Web Crypto API.
When enabled, cell data, settings, installed modules, and the embedded filesystem are
encrypted as a single blob. The HTML/CSS/JS runtime stays cleartext so the notebook can
still open in any browser and show the lock screen.

---

## How It Works

The encryption uses a two-layer key model. Your passphrase never encrypts data directly.
Instead:

1. Your passphrase is run through **PBKDF2** (600,000 iterations, SHA-256) to derive a
   wrapping key
2. The wrapping key unwraps a **Data Encryption Key (DEK)** --- a random AES-256 key
   generated once when encryption is first enabled
3. The DEK encrypts and decrypts the notebook payload via **AES-256-GCM**

The DEK is wrapped independently by each unlock method (passphrase and recovery key),
so changing your passphrase only re-wraps the DEK --- the data payload is never
re-encrypted.

---

## Enabling Encryption

1. Open **Settings** (gear icon or ++s++ from keyboard)
2. Scroll to the **Encryption** section
3. Enter a passphrase and confirm it
4. **Save the recovery key** --- this is shown once and is your only backup if you forget
   the passphrase
5. Save the notebook --- data is now encrypted

The recovery key is displayed as 64 hex characters grouped in blocks of four:

```
A7B4 767C DC50 DE62 E962 F5BC 8C7B 03E1
B4DC 03D7 8A81 4D6D F2E9 8132 0A5F 3C71
```

A modal provides **Copy** and **Download as .txt** buttons. You must tick the "I have
saved my recovery key" checkbox before proceeding.

!!! warning
    The recovery key is the **only** way to access your data if you forget the passphrase.
    Store it somewhere safe --- a password manager, printed copy, or separate encrypted file.

---

## The Lock Screen

When you open an encrypted notebook, you see a lock screen instead of the editor. Enter
your passphrase to decrypt and resume editing. Key derivation runs in a Web Worker so the
lock screen stays responsive (expect 0.5--2 seconds depending on hardware).

If you enter the wrong passphrase, a check value is verified first for fast rejection ---
there is no attempt limit, since PBKDF2 is the throttle.

If you have forgotten your passphrase, click **Use recovery key** and paste the hex key
you saved when enabling encryption.

---

## Recovery Key

The recovery key is a random 256-bit value that provides an alternative way to decrypt
the notebook. Unlike the passphrase path, it derives a wrapping key via HKDF-SHA256 ---
near-instant, no PBKDF2 needed, because the key is already high entropy.

When to use it:

- You have forgotten your passphrase
- You need to decrypt on a machine where typing a long passphrase is impractical

To regenerate: **Settings** --> **Encryption** --> **Regenerate recovery key**. The old
key is immediately invalidated and a new one is displayed.

!!! tip
    Regenerating the recovery key invalidates the old one. If you suspect your recovery
    key was exposed, regenerate it immediately.

---

## Changing the Passphrase

**Settings** --> **Encryption** --> **Change passphrase**. Enter your current passphrase
for confirmation, then set a new one.

This only re-wraps the DEK with a new passphrase-derived key --- the data payload is not
re-encrypted, so the operation is fast regardless of notebook size. A fresh salt is
generated on every passphrase change.

---

## Locking

Lock the notebook via **Settings** --> **Encryption** --> **Lock notebook**, or simply
close the browser tab. Locking clears the DEK from memory and returns the notebook to
the lock screen. Any connected MCP agents are blocked and the MCP audit log is cleared.

---

## What's Encrypted

| Encrypted | Not encrypted |
|-----------|---------------|
| Cell source code and output | HTML structure |
| Settings (theme, width, etc.) | CSS styles |
| Installed modules and binaries | JavaScript runtime |
| Embedded filesystem | Self-extracting loader |
| Notebook title | |

The saved HTML shows `<title>Auditable --- Encrypted</title>` and clears module URLs from
the settings panel to prevent metadata leakage. The real title is stored inside the
encrypted payload and restored after decryption.

---

## Interaction with Other Features

### MCP bridge

When the notebook is locked, all MCP tools except `getDocumentation` and
`getNotebookStatus` are blocked. `getNotebookStatus` reports a `locked` flag so agents
can detect the state. On re-lock, the MCP audit log is cleared and auto-accept permissions
are reset.

### AF workspace

AF handles encrypted notebooks transparently --- the lock screen appears inside the
notebook iframe. AF never sees the passphrase or the decrypted content. When an encrypted
notebook is dropped into an AF box, AF stores the encrypted payload as-is without
attempting decryption.

### Saves and exports

Encrypted saves replace all cleartext data blocks (`DATA`, `SETTINGS`, `MODULES`, `FS`)
with a single `AUDITABLE-CRYPTO` block. Packed saves encrypt the data before packing.
Export as `.txt` is not available for encrypted notebooks. Export App requires the notebook
to be unlocked first --- the exported app is unencrypted.

---

## Passphrase Strength

The passphrase input shows a strength indicator estimating brute-force resistance against
a GPU cluster (~100,000 PBKDF2 guesses/second). Longer passphrases with more character
variety score higher. Four or more random words make a strong passphrase.

Auditable does not enforce a minimum length --- you may have legitimate reasons for a
short passphrase (test notebooks, temporary encryption). The strength feedback is
informational, not a gate.

---

## Technical Details

| Parameter | Value |
|-----------|-------|
| Cipher | AES-256-GCM (Web Crypto API) |
| Key derivation | PBKDF2, 600,000 iterations, SHA-256, random 16-byte salt |
| Recovery key derivation | HKDF-SHA256 with fixed info string |
| DEK model | Random AES-256 key, wrapped independently per method |
| Payload IV | Fresh random 12 bytes on every save |
| Wrap IVs | Fresh random 12 bytes per method on every save |
| Check value | Fixed string encrypted with wrapping key for fast passphrase verification |

Every save generates fresh IVs for the payload, each method's DEK wrapping, and the
check value. Identical content produces different ciphertext on every save.

!!! info
    The full cryptographic design, threat model, and future extensions (WebAuthn PRF,
    Argon2id, Shamir's Secret Sharing) are documented in `ext/crypto/SPEC.md`.
