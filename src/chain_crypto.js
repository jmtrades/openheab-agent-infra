// ============================================================================
// chain_crypto.js — pure-stdlib keypair + address derivation
// Solana (ed25519) + Bitcoin (secp256k1 P2PKH)
// ============================================================================
const crypto = require('crypto');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  if (buf.length === 0) return '';
  let intVal = 0n;
  for (const byte of buf) intVal = (intVal << 8n) + BigInt(byte);
  let out = '';
  while (intVal > 0n) {
    const rem = intVal % 58n;
    intVal = intVal / 58n;
    out = B58_ALPHABET[Number(rem)] + out;
  }
  for (const byte of buf) {
    if (byte === 0) out = '1' + out; else break;
  }
  return out;
}

function base58Decode(str) {
  let intVal = 0n;
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid_base58');
    intVal = intVal * 58n + BigInt(idx);
  }
  const bytes = [];
  while (intVal > 0n) {
    bytes.unshift(Number(intVal & 0xffn));
    intVal >>= 8n;
  }
  for (const ch of str) {
    if (ch === '1') bytes.unshift(0); else break;
  }
  return Buffer.from(bytes);
}

function provisionSolanaKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPub = Buffer.from(jwk.x, 'base64url');
  if (rawPub.length !== 32) throw new Error('unexpected_ed25519_pub_length');
  return {
    address: base58Encode(rawPub),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

function compressPublicKeyFromUncompressed(uncompressed) {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('expected_uncompressed_secp256k1_pubkey');
  }
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);
  const prefix = (y[y.length - 1] % 2 === 0) ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

function provisionBitcoinKeypair({ network = 'mainnet' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const rawPub = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(rawPub.x, 'base64url');
  const y = Buffer.from(rawPub.y, 'base64url');
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  const compressed = compressPublicKeyFromUncompressed(uncompressed);

  const sha = crypto.createHash('sha256').update(compressed).digest();
  const ripemd = crypto.createHash('ripemd160').update(sha).digest();
  const version = network === 'testnet' ? 0x6f : 0x00;
  const payload = Buffer.concat([Buffer.from([version]), ripemd]);
  const c1 = crypto.createHash('sha256').update(payload).digest();
  const c2 = crypto.createHash('sha256').update(c1).digest();
  const checksum = c2.subarray(0, 4);
  const address = base58Encode(Buffer.concat([payload, checksum]));

  return {
    address, network,
    publicKeyCompressedHex: compressed.toString('hex'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

module.exports = {
  base58Encode, base58Decode,
  provisionSolanaKeypair, provisionBitcoinKeypair
};
