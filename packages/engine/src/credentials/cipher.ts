/**
 * Envelope encryption for org credentials (DECISIONS D17).
 *
 * Each secret is encrypted with its own random 256-bit data key (AES-256-GCM); the data key is
 * encrypted with the master key (AES-256-GCM). Both layers authenticate `aad`
 * (org id + credential id + provider), so a ciphertext copied to another org or record fails to
 * decrypt. Master keys come from env and carry an id, so old records stay readable after rotation.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  keyId: string;
  /** base64 fields */
  wrappedKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEncryptionError';
  }
}

function seal(key: Buffer, plaintext: Buffer, aad: string): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseKey(id: string, base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new CredentialEncryptionError(`Credential encryption key "${id}" must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
  return key;
}

export class CredentialCipher {
  private readonly keys = new Map<string, Buffer>();

  /**
   * @param primary key used for new records
   * @param previous older keys, kept only to decrypt existing records
   */
  constructor(primary: { id: string; key: string }, previous: { id: string; key: string }[] = []) {
    this.primaryId = primary.id;
    this.keys.set(primary.id, parseKey(primary.id, primary.key));
    for (const p of previous) this.keys.set(p.id, parseKey(p.id, p.key));
  }

  readonly primaryId: string;

  /**
   * From env: CREDENTIALS_ENCRYPTION_KEY (base64, 32 bytes), CREDENTIALS_KEY_ID (default "k1"),
   * CREDENTIALS_PREVIOUS_KEYS ("id:base64,id:base64"). Returns null if no key is configured.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CredentialCipher | null {
    const key = env.CREDENTIALS_ENCRYPTION_KEY?.trim();
    if (!key) return null;
    const previous = (env.CREDENTIALS_PREVIOUS_KEYS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf(':');
        if (at <= 0) throw new CredentialEncryptionError('CREDENTIALS_PREVIOUS_KEYS entries must look like "id:base64key"');
        return { id: entry.slice(0, at), key: entry.slice(at + 1) };
      });
    return new CredentialCipher({ id: env.CREDENTIALS_KEY_ID?.trim() || 'k1', key }, previous);
  }

  encrypt(plaintext: string, aad: string): EncryptedSecret {
    const dataKey = randomBytes(32);
    const inner = seal(dataKey, Buffer.from(plaintext, 'utf8'), aad);
    const wrapped = seal(this.keys.get(this.primaryId)!, dataKey, aad);
    dataKey.fill(0);
    return {
      keyId: this.primaryId,
      wrappedKey: wrapped.data.toString('base64'),
      wrappedKeyIv: wrapped.iv.toString('base64'),
      wrappedKeyTag: wrapped.tag.toString('base64'),
      iv: inner.iv.toString('base64'),
      tag: inner.tag.toString('base64'),
      ciphertext: inner.data.toString('base64'),
    };
  }

  decrypt(encrypted: EncryptedSecret, aad: string): string {
    const master = this.keys.get(encrypted.keyId);
    if (!master) throw new CredentialEncryptionError(`No encryption key with id "${encrypted.keyId}" is configured`);
    try {
      const b = (s: string) => Buffer.from(s, 'base64');
      const dataKey = open(master, b(encrypted.wrappedKeyIv), b(encrypted.wrappedKeyTag), b(encrypted.wrappedKey), aad);
      const plaintext = open(dataKey, b(encrypted.iv), b(encrypted.tag), b(encrypted.ciphertext), aad);
      dataKey.fill(0);
      return plaintext.toString('utf8');
    } catch {
      // Never include key material or ciphertext in the error
      throw new CredentialEncryptionError('Credential could not be decrypted (wrong key, tampered data, or wrong org/record)');
    }
  }
}
