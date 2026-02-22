#!/usr/bin/env node
// Generate an Ed25519 keypair for signing auditable builds.
// Run once, then paste the printed gh commands to store the keys.

const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });

// Ed25519 SPKI DER has a 12-byte header, raw key is last 32 bytes
const pub = pubRaw.slice(-32).toString('base64');
// Ed25519 PKCS8 DER has a 16-byte header, raw seed+key follows
const priv = privRaw.slice(-32).toString('base64');

console.log('# Run these commands to store the keys on GitHub:\n');
console.log(`gh variable set AUDITABLE_PUBLIC_KEY --body "${pub}"`);
console.log(`gh secret set ED25519_PRIVATE_KEY --body "${priv}"`);
