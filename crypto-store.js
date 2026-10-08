// AES-256-GCM encryption for biometric data at rest (face descriptors + thumbnail).
// Key: FACE_DATA_KEY (64 hex chars) or an auto-generated key file next to the DB. In-memory DBs use a throwaway key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** @param {{keyHex?: string, keyFile?: string}} [opts] */
export function createCipher({ keyHex = process.env.FACE_DATA_KEY, keyFile } = {}) {
  let key;
  if (keyHex) key = Buffer.from(keyHex, 'hex');
  else if (keyFile) {
    if (fs.existsSync(keyFile)) key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    else {
      key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    }
  } else key = crypto.randomBytes(32);
  if (key.length !== 32) throw new Error('FACE_DATA_KEY must be 32 bytes (64 hex chars)');

  return {
    /** @param {unknown} value */
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    /** @param {string} blob */
    decrypt(blob) {
      const raw = Buffer.from(blob, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    },
  };
}
