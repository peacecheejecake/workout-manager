import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GarminCipher } from './garmin-ports.js';
/**
 * Bound into the AAD with the key id and account, so an envelope decrypts only under the
 * purpose it was written for. `unofficial-session` (M1-06b-tmp) keeps the temporary
 * collector's library session from ever being read as an official OAuth credential, and
 * the reverse.
 */
export type GarminCipherPurpose = 'tokens' | 'verifier' | 'unofficial-session';
const envelopeSchema = z.strictObject({
  keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  iv: z.string().base64(),
  ciphertext: z.string().base64().max(65536),
  tag: z.string().base64(),
});
export function createGarminCipher(options: {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}) {
  if (Object.keys(options.keys).length > 10) throw new Error('INVALID_GARMIN_KEYS');
  const keys = new Map(
    Object.entries(options.keys).map(([id, value]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !z.string().base64().safeParse(value).success)
        throw new Error('INVALID_GARMIN_KEYS');
      const key = Buffer.from(value, 'base64');
      if (key.length !== 32) throw new Error('INVALID_GARMIN_KEYS');
      return [id, key] as const;
    }),
  );
  if (!keys.has(options.activeKeyId)) throw new Error('INVALID_GARMIN_KEYS');
  return {
    encrypt(athleteId: string, purpose: GarminCipherPurpose, value: unknown): GarminCipher {
      const key = keys.get(options.activeKeyId);
      if (!key) throw new Error('INVALID_GARMIN_KEYS');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(
        Buffer.from(JSON.stringify(['garmin', options.activeKeyId, athleteId, purpose])),
      );
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 32768) throw new Error('INVALID_GARMIN_SECRET');
      const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
      return {
        keyId: options.activeKeyId,
        iv: iv.toString('base64'),
        ciphertext: encrypted.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    },
    decrypt(athleteId: string, purpose: GarminCipherPurpose, input: GarminCipher): unknown {
      const envelope = envelopeSchema.parse(input);
      const key = keys.get(envelope.keyId);
      if (!key) throw new Error('UNKNOWN_GARMIN_KEY');
      const iv = Buffer.from(envelope.iv, 'base64'),
        tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('INVALID_GARMIN_SECRET');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(JSON.stringify(['garmin', envelope.keyId, athleteId, purpose])));
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      ) as unknown;
    },
  };
}
export type GarminEncryption = ReturnType<typeof createGarminCipher>;
