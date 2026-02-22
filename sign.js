#!/usr/bin/env node
// Sign an auditable HTML file with Ed25519.
// Usage: node sign.js auditable.html [--key=base64 | uses ED25519_PRIVATE_KEY env]

const crypto = require('crypto');
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node sign.js <file.html> [--key=<base64-private-key>]');
  process.exit(1);
}

// Get private key: --key arg or env var
let privB64 = (process.argv.find(a => a.startsWith('--key=')) || '').split('=').slice(1).join('=');
if (!privB64) privB64 = process.env.ED25519_PRIVATE_KEY;
if (!privB64) {
  console.error('No private key. Set ED25519_PRIVATE_KEY env or pass --key=<base64>');
  process.exit(1);
}

const privSeed = Buffer.from(privB64, 'base64');
if (privSeed.length !== 32) {
  console.error('Private key seed must be 32 bytes (got ' + privSeed.length + ')');
  process.exit(1);
}

// Build PKCS8 DER wrapper for Ed25519 private key seed
// Prefix: 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 (16 bytes)
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8Der = Buffer.concat([pkcs8Prefix, privSeed]);
const privateKey = crypto.createPrivateKeyObject
  ? crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' })
  : crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

// Derive public key
const publicKey = crypto.createPublicKey(privateKey);
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const pubRaw = pubDer.slice(-32);
const pubB64 = pubRaw.toString('base64');

// Read HTML
let html = fs.readFileSync(file, 'utf8');

// Remove any existing signature comment
html = html.replace(/<!--AUDITABLE-SIGNATURE\n[\s\S]*?\nAUDITABLE-SIGNATURE-->\n?/g, '');

// Extract style and script content
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!styleMatch || !scriptMatch) {
  console.error('Could not find <style> or <script> in ' + file);
  process.exit(1);
}

// Construct deterministic signed content
const signedContent = 'AUDITABLE-SIGNED-CONTENT\n'
  + styleMatch[1] + '\n'
  + 'AUDITABLE-STYLE-SCRIPT-BOUNDARY\n'
  + scriptMatch[1];

const message = Buffer.from(signedContent, 'utf8');
const sig = crypto.sign(null, message, privateKey);

const sigObj = {
  v: 1,
  sig: sig.toString('base64'),
  pub: pubB64,
  alg: 'Ed25519'
};

const sigComment = '<!--AUDITABLE-SIGNATURE\n' + JSON.stringify(sigObj) + '\nAUDITABLE-SIGNATURE-->';

// Inject before <script> tag
html = html.replace(/<script>/, sigComment + '\n<script>');

fs.writeFileSync(file, html);
console.log('Signed ' + file + ' (pub: ' + pubB64.slice(0, 8) + '...)');
