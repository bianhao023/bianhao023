import {
  createSign,
  createVerify,
  createDecipheriv,
  timingSafeEqual,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * Cryptographic primitives shared by the WeChat and Alipay providers.
 * All RSA operations use SHA-256 (RSA2 / WECHATPAY2-SHA256-RSA2048).
 */

/** Sign `message` with an RSA private key (PEM), returning base64. */
export function rsaSignSha256(message: string, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/** Verify a base64 RSA-SHA256 signature against a PEM public key / certificate. */
export function rsaVerifySha256(
  message: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch {
    return false;
  }
}

/**
 * Decrypt a WeChat Pay v3 notification `resource` object.
 * WeChat encrypts with AES-256-GCM; the APIv3 key is the symmetric key, the
 * last 16 bytes of the ciphertext are the GCM auth tag.
 */
export function aesGcmDecrypt(
  apiV3Key: string,
  nonce: string,
  associatedData: string,
  ciphertextB64: string,
): string {
  const key = Buffer.from(apiV3Key, 'utf8');
  const data = Buffer.from(ciphertextB64, 'base64');
  const authTag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Constant-time string comparison to avoid timing side channels. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Hash a password with scrypt, returning `salt:hash` (both hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Verify a password against a `salt:hash` value in constant time. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
