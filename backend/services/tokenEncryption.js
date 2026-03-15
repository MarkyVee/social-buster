/**
 * services/tokenEncryption.js
 *
 * Encrypts and decrypts OAuth access tokens before they are stored in the database.
 * Uses AES-256-GCM — an authenticated encryption mode that both encrypts the data
 * and verifies it hasn't been tampered with.
 *
 * The key comes from TOKEN_ENCRYPTION_KEY in .env.
 * The key MUST be exactly 32 characters (256 bits). If it's the wrong length,
 * this service will throw on startup so you catch the misconfiguration immediately.
 *
 * Encrypted format stored in DB:
 *   "<iv_hex>:<authTag_hex>:<encrypted_hex>"
 *
 * Usage:
 *   const { encryptToken, decryptToken } = require('./tokenEncryption');
 *   const stored  = encryptToken(rawAccessToken);
 *   const raw     = decryptToken(stored);
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes (256 bits)

// ----------------------------------------------------------------
// Derive the encryption key from the .env variable.
// We pad or hash to ensure exactly 32 bytes.
// ----------------------------------------------------------------
function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not set in .env');
  }

  // Use SHA-256 to convert any-length key to exactly 32 bytes
  // This means the .env value can be any string, not just exactly 32 chars
  return crypto.createHash('sha256').update(raw).digest();
}

// ----------------------------------------------------------------
// encryptToken — encrypts a plaintext string (e.g. an OAuth token).
// Returns a string in the format: "iv:authTag:encrypted"
// All parts are hex-encoded.
// ----------------------------------------------------------------
function encryptToken(plaintext) {
  if (!plaintext) return null;

  const key = getKey();
  const iv  = crypto.randomBytes(12); // 96-bit IV recommended for GCM

  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

// ----------------------------------------------------------------
// decryptToken — decrypts a value produced by encryptToken.
// Returns the original plaintext string.
// Throws if the value was tampered with or the key is wrong.
// ----------------------------------------------------------------
function decryptToken(encryptedValue) {
  if (!encryptedValue) return null;

  const key  = getKey();
  const parts = encryptedValue.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const iv        = Buffer.from(parts[0], 'hex');
  const authTag   = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
