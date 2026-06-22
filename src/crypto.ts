import {
  generateKeyPairSync,
  privateDecrypt,
  createPrivateKey,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  constants,
} from 'crypto';

export interface RsaKeyPair {
  publicKeyPem: string;
  privateKeyDer: Buffer; // DER format so we can zero it after use
}

export function generateRsaKeyPair(): RsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKeyPem: publicKey as string,
    privateKeyDer: privateKey as Buffer,
  };
}

// Decrypts the AES-256 session key using the RSA private key (OAEP padding).
// Caller must zero privateKeyDer immediately after calling this.
export function decryptSessionKey(
  sessionKeyEncryptedBase64: string,
  privateKeyDer: Buffer,
): Buffer {
  const privateKey = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  const encrypted = Buffer.from(sessionKeyEncryptedBase64, 'base64');
  return privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, encrypted);
}

// Zero a Buffer in place. Best-effort in a GC runtime — eliminates the key
// from the heap region we control, even if GC copies are possible.
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

// Encrypts plaintext with AES-256-GCM using sessionKey.
// Wire format (base64): nonce(12 bytes) || ciphertext || authTag(16 bytes)
// Each call uses a unique random nonce — never reuse.
export function encryptWithSessionKey(plaintext: Buffer, sessionKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, authTag]).toString('base64');
}

// Decrypts AES-256-GCM payload produced by encryptWithSessionKey.
// Throws if authentication tag verification fails (tampered payload).
export function decryptWithSessionKey(encryptedBase64: string, sessionKey: Buffer): Buffer {
  const buf = Buffer.from(encryptedBase64, 'base64');
  if (buf.length < 28) {
    throw new Error('Encrypted payload too short to be valid (nonce + authTag minimum)');
  }
  const nonce = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
