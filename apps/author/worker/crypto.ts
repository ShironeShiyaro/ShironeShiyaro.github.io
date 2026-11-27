/**
 * Web Crypto helpers for the author Worker/DO.
 *
 * Security rules encoded here:
 * - tokens are encrypted at rest with AES-GCM (random 96-bit IV per value);
 * - session ids and CSRF tokens are never stored in plaintext (HMAC only);
 * - comparisons are constant-time;
 * - no helper ever logs its inputs.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  return base64ToBytes(remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`);
}

/** Cryptographically random URL-safe string with `byteLength` bytes of entropy. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error('The configured session secret is too short.');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Constant-time comparison for two strings of arbitrary length. */
export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Resolves the configured token key material.
 *
 * Accepted formats (in order): 64 hex characters, base64/base64url that
 * decodes to exactly 32 bytes, or any UTF-8 secret of at least 32 bytes which
 * is hashed with SHA-256. The last case keeps the deployment usable when the
 * operator supplies a long random passphrase instead of a raw key, without
 * accepting a short/low-entropy value.
 */
async function deriveEncryptionKey(rawKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const trimmed = rawKey.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/u.test(trimmed)) {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    try {
      const decoded = base64ToBytes(padded);
      if (decoded.length === 32) {
        return decoded;
      }
    } catch {
      // fall through to the passphrase form
    }
  }
  if (encoder.encode(trimmed).length < 32) {
    throw new Error(
      'The configured token encryption key must be 64 hex characters, base64 for 32 bytes, or at least 32 bytes of text.',
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(trimmed));
  return new Uint8Array(digest);
}

async function importEncryptionKey(rawKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await deriveEncryptionKey(rawKey), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM encrypts a secret; output is `v1.<base64url iv>.<base64url ciphertext>`. */
export async function encryptSecret(plaintext: string, rawKey: string): Promise<string> {
  const key = await importEncryptionKey(rawKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

/** AES-GCM decrypts a value produced by `encryptSecret`; throws when tampered. */
export async function decryptSecret(payload: string, rawKey: string): Promise<string> {
  const [version, ivText, ciphertextText] = payload.split('.');
  if (version !== 'v1' || !ivText || !ciphertextText) {
    throw new Error('The stored secret has an unsupported format.');
  }
  const key = await importEncryptionKey(rawKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(ivText) },
    key,
    base64UrlToBytes(ciphertextText),
  );
  return decoder.decode(plaintext);
}
