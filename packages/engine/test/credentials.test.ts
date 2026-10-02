import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { CredentialCipher, CredentialEncryptionError } from '../src/credentials/cipher.ts';
import { maskSecret, Secret } from '../src/credentials/secret.ts';
import { CredentialError, CredentialService, platformKeysFromEnv } from '../src/credentials/service.ts';
import { InMemoryCredentialStore } from '../src/credentials/store.ts';
import { createLogger } from '../src/logger.ts';

const key = () => randomBytes(32).toString('base64');
const SECRET = 'sk-live-THIS-IS-THE-REAL-SECRET-9f3a';

function service(options: { platform?: Record<string, string>; cipher?: CredentialCipher | null } = {}) {
  const store = new InMemoryCredentialStore();
  const cipher = options.cipher === undefined ? new CredentialCipher({ id: 'k1', key: key() }) : options.cipher;
  return { store, svc: new CredentialService(store, cipher, platformKeysFromEnv(options.platform ?? {})) };
}

describe('masking and Secret', () => {
  it.each([
    [SECRET, '••••9f3a'],
    ['abcdefghijklmnop', '••••mnop'],
    ['short-secret', '••••'],
    ['', '••••'],
  ])('masks %s as %s', (input, masked) => {
    expect(maskSecret(input)).toBe(masked);
  });

  it('never prints a Secret, however it is logged or serialized', () => {
    const secret = new Secret(SECRET);
    const lines: string[] = [];
    createLogger({ level: 'info', sink: (l) => lines.push(l) }).info({ apiKey: secret, nested: { secret } }, 'using key');
    const outputs = [JSON.stringify({ secret }), String(secret), `${secret}`, inspect(secret), inspect({ deep: { secret } }), ...lines];
    for (const out of outputs) expect(out).not.toContain(SECRET);
    expect(secret.reveal()).toBe(SECRET);
  });
});

describe('envelope encryption', () => {
  const aad = 'org=org_a;credential=c1;provider=openai';

  it('round-trips and uses a fresh data key and IV every time', () => {
    const cipher = new CredentialCipher({ id: 'k1', key: key() });
    const a = cipher.encrypt(SECRET, aad);
    const b = cipher.encrypt(SECRET, aad);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(cipher.decrypt(a, aad)).toBe(SECRET);
    expect(JSON.stringify(a)).not.toContain(SECRET);
  });

  it('detects tampering with the ciphertext or the wrapped key', () => {
    const cipher = new CredentialCipher({ id: 'k1', key: key() });
    const enc = cipher.encrypt(SECRET, aad);
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64');
      bytes[0] ^= 1;
      return bytes.toString('base64');
    };
    expect(() => cipher.decrypt({ ...enc, ciphertext: flip(enc.ciphertext) }, aad)).toThrow(CredentialEncryptionError);
    expect(() => cipher.decrypt({ ...enc, wrappedKey: flip(enc.wrappedKey) }, aad)).toThrow(CredentialEncryptionError);
  });

  it('binds the ciphertext to its org and record (cannot be replayed into another org)', () => {
    const cipher = new CredentialCipher({ id: 'k1', key: key() });
    const enc = cipher.encrypt(SECRET, aad);
    expect(() => cipher.decrypt(enc, 'org=org_b;credential=c1;provider=openai')).toThrow(/could not be decrypted/);
  });

  it('fails with the wrong master key, without leaking anything in the error', () => {
    const enc = new CredentialCipher({ id: 'k1', key: key() }).encrypt(SECRET, aad);
    const error = (() => {
      try {
        new CredentialCipher({ id: 'k1', key: key() }).decrypt(enc, aad);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(CredentialEncryptionError);
    expect(error!.message).not.toContain(enc.ciphertext);
  });

  it('keeps old records readable after key rotation', () => {
    const oldKey = key();
    const enc = new CredentialCipher({ id: 'k1', key: oldKey }).encrypt(SECRET, aad);
    const rotated = CredentialCipher.fromEnv({ CREDENTIALS_ENCRYPTION_KEY: key(), CREDENTIALS_KEY_ID: 'k2', CREDENTIALS_PREVIOUS_KEYS: `k1:${oldKey}` })!;
    expect(rotated.decrypt(enc, aad)).toBe(SECRET);
    expect(rotated.encrypt('x'.repeat(10), aad).keyId).toBe('k2');
  });

  it('validates key configuration', () => {
    expect(CredentialCipher.fromEnv({})).toBeNull();
    expect(() => new CredentialCipher({ id: 'k1', key: randomBytes(16).toString('base64') })).toThrow(/must be 32 bytes/);
    expect(() => CredentialCipher.fromEnv({ CREDENTIALS_ENCRYPTION_KEY: key(), CREDENTIALS_PREVIOUS_KEYS: 'nocolon' })).toThrow(/id:base64key/);
  });
});

describe('CredentialService', () => {
  it('stores encrypted and returns only masked views', async () => {
    const { svc, store } = service();
    const created = await svc.create('org_a', { provider: 'openai', secret: SECRET, label: 'Prod OpenAI' });
    expect(created).toEqual({ id: expect.any(String), orgId: 'org_a', provider: 'openai', label: 'Prod OpenAI', masked: '••••9f3a', createdAt: expect.any(String) });
    const listed = await svc.list('org_a');
    const fetched = await svc.get('org_a', created.id);
    for (const out of [created, listed, fetched]) {
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(out)).not.toContain('encrypted');
    }
    // At rest: no plaintext anywhere in the stored record
    expect(JSON.stringify(await store.list('org_a'))).not.toContain(SECRET);
  });

  it('isolates orgs: another org cannot list, read, resolve or delete a credential', async () => {
    const { svc } = service();
    const created = await svc.create('org_a', { provider: 'openai', secret: SECRET });
    expect(await svc.list('org_b')).toEqual([]);
    expect(await svc.get('org_b', created.id)).toBeNull();
    expect(await svc.resolveKey('org_b', 'openai')).toBeNull();
    await expect(svc.resolveById('org_b', created.id)).rejects.toMatchObject({ code: 'not-found' });
    expect(await svc.delete('org_b', created.id)).toBe(false);
    expect(await svc.get('org_a', created.id)).not.toBeNull();
  });

  it('resolves the org key first, else the platform key, else nothing', async () => {
    const { svc } = service({ platform: { OPENAI_API_KEY: 'platform-openai-key-1234' } });
    const platform = await svc.resolveKey('org_a', 'openai');
    expect(platform).toMatchObject({ source: 'platform' });
    expect(platform!.secret.reveal()).toBe('platform-openai-key-1234');

    const created = await svc.create('org_a', { provider: 'openai', secret: SECRET });
    const own = await svc.resolveKey('org_a', 'openai');
    expect(own).toMatchObject({ source: 'org', credentialId: created.id });
    expect(own!.secret.reveal()).toBe(SECRET);
    expect((await svc.get('org_a', created.id))!.lastUsedAt).toBeDefined();

    expect(await svc.resolveKey('org_a', 'cartesia')).toBeNull();
  });

  it('validates input and refuses to store keys without an encryption key', async () => {
    const { svc } = service();
    await expect(svc.create('org_a', { provider: 'acme', secret: SECRET })).rejects.toThrow(/Unknown credential provider "acme"/);
    await expect(svc.create('org_a', { provider: 'openai', secret: 'short' })).rejects.toBeInstanceOf(CredentialError);
    await expect(svc.create('org_a', { provider: 'openai', secret: 'has space in it' })).rejects.toThrow(/no whitespace/);
    const noCipher = service({ cipher: null }).svc;
    await expect(noCipher.create('org_a', { provider: 'openai', secret: SECRET })).rejects.toMatchObject({ code: 'encryption-unavailable' });
  });

  it('reads platform keys from env per vendor', () => {
    const keys = platformKeysFromEnv({ GEMINI_API_KEY: 'g-key', DEEPGRAM_API_KEY: ' ', OPENAI_API_KEY: 'o-key' });
    expect([...keys.keys()].sort()).toEqual(['google', 'openai']);
  });
});
