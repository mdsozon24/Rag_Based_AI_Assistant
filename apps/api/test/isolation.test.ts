/**
 * Org isolation: org A can never read, update or delete org B's resources, through any endpoint,
 * whether A calls with a dashboard session or a private API key. A second layer (row-level
 * security) is tested directly: a query that forgets its org filter still sees only its own org.
 *
 * Coverage is enforced: every registered /v1 route must appear in COVERED below, so a new
 * endpoint cannot ship without an isolation case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createKey, createTestApp, json, keyCaller, signUp, tokenFromEmail, uniqueEmail, type Caller, type SignedUp, type TestApp } from './helpers.ts';

let t: TestApp;
let A: SignedUp;
let B: SignedUp;
let bMember: SignedUp;
let aKey: Caller;
let b: { keyId: string; key: string; credentialId: string; invitationId: string; invitationEmail: string; invitationToken: string };

/** Snapshot of everything org B owns, to prove nothing changed. */
async function snapshotB() {
  const q = async (sql: string) => (await t.db.query(sql, [B.orgId])).rows;
  return {
    org: await q('SELECT id, name, status FROM org WHERE id = $1'),
    members: await q('SELECT user_id, role FROM membership WHERE org_id = $1 ORDER BY user_id'),
    keys: await q('SELECT id, name, revoked_at FROM api_key WHERE org_id = $1 ORDER BY id'),
    credentials: await q('SELECT id, label FROM provider_credential WHERE org_id = $1 ORDER BY id'),
    invitations: await q('SELECT id, revoked_at, accepted_at FROM invitation WHERE org_id = $1 ORDER BY id'),
  };
}

beforeAll(async () => {
  t = await createTestApp();
  A = await signUp(t, { orgName: 'Org A' });
  B = await signUp(t, { orgName: 'Org B' });
  bMember = await addMember(t, B, 'member');
  aKey = keyCaller(t, (await createKey(A.caller)).key, 'A private key');
  await addMember(t, A, 'viewer');

  const bKey = await createKey(B.caller, { name: 'B server key', type: 'private' });
  const cred = json(await B.caller.request('POST', '/v1/credentials', { provider: 'openai', secret: 'sk-org-b-secret-123456', label: 'B OpenAI' }));
  const invitationEmail = uniqueEmail('b-invitee');
  const inv = json(await B.caller.request('POST', '/v1/invitations', { email: invitationEmail, role: 'member' }));
  b = { keyId: bKey.id, key: bKey.key, credentialId: cred.id, invitationId: inv.id, invitationEmail, invitationToken: tokenFromEmail(t.outbox, invitationEmail) };
  await A.caller.request('POST', '/v1/credentials', { provider: 'google', secret: 'org-a-gemini-key-123456' });
});
afterAll(async () => t.close());

/** Every route, with how the isolation suite exercises it. */
const COVERED: Record<string, string> = {
  'POST /v1/auth/signup': 'public: creates a new user and org only',
  'POST /v1/auth/verify-email': 'public: token-bound to one user',
  'POST /v1/auth/resend-verification': 'public: email-bound, no data returned',
  'POST /v1/auth/login': 'public: lands in own orgs only (tested)',
  'POST /v1/auth/logout': 'own session only',
  'POST /v1/auth/forgot-password': 'public: email-bound, no data returned',
  'POST /v1/auth/reset-password': 'public: token-bound to one user',
  'GET /v1/auth/google/start': 'public',
  'GET /v1/auth/google/callback': 'public: lands in own orgs only',
  'GET /v1/me': 'lists only own memberships (tested)',
  'PUT /v1/me/active-org': 'cannot select a foreign org (tested)',
  'POST /v1/orgs': 'creates a new org owned by the caller',
  'POST /v1/invitations/accept': "foreign org's invitation for another email refused (tested)",
  'GET /v1/org': 'tested',
  'PATCH /v1/org': 'tested',
  'DELETE /v1/org': 'tested',
  'GET /v1/members': 'tested',
  'PATCH /v1/members/:userId': 'tested',
  'DELETE /v1/members/:userId': 'tested',
  'POST /v1/invitations': 'creates in own org only (tested)',
  'GET /v1/invitations': 'tested',
  'DELETE /v1/invitations/:id': 'tested',
  'POST /v1/api-keys': 'creates in own org only (tested)',
  'GET /v1/api-keys': 'tested',
  'GET /v1/api-keys/:id': 'tested',
  'DELETE /v1/api-keys/:id': 'tested',
  'POST /v1/credentials': 'creates in own org only (tested)',
  'GET /v1/credentials': 'tested',
  'GET /v1/credentials/:id': 'tested',
  'DELETE /v1/credentials/:id': 'tested',
  'GET /v1/audit-logs': 'tested',
  'GET /v1/assistant-templates': 'templates contain no tenant data',
  'POST /v1/assistants': 'creates in own org only (tested in assistant suite)',
  'GET /v1/assistants': 'lists only own org assistants (tested in assistant suite)',
  'GET /v1/assistants/:id': 'org scoped lookup (tested in assistant suite)',
  'PATCH /v1/assistants/:id': 'org scoped update (tested in assistant suite)',
  'DELETE /v1/assistants/:id': 'org scoped delete (tested in assistant suite)',
  'POST /v1/assistants/:id/publish': 'org scoped publication (tested in assistant suite)',
  'GET /v1/assistants/:id/versions': 'org scoped history (tested in assistant suite)',
  'GET /v1/assistants/:id/versions/:version': 'org scoped version lookup (tested in assistant suite)',
  'POST /v1/assistants/:id/rollback': 'org scoped rollback (tested in assistant suite)',
  'POST /v1/calls': 'creates calls in own org only (tested in assistant suite)',
  'POST /v1/assistants/:id/test-call': 'test calls are org scoped (tested in assistant suite)',
  'POST /v1/tools': 'creates in own org only (tested in tool suite)',
  'GET /v1/tools': 'lists only own org tools (tested in tool suite)',
  'GET /v1/tools/:id': 'org scoped lookup (tested in tool suite)',
  'PATCH /v1/tools/:id': 'org scoped update (tested in tool suite)',
  'DELETE /v1/tools/:id': 'org scoped delete (tested in tool suite)',
  'POST /v1/tools/:id/test': 'org scoped execution (tested in tool suite)',
  'POST /v1/phone-numbers/import': 'imports into own org only (tested in telephony suite)',
  'POST /v1/phone-numbers/buy': 'purchases into own org only (tested in telephony suite)',
  'GET /v1/phone-numbers': 'lists only own org numbers (tested in telephony suite)',
  'GET /v1/phone-numbers/:id': 'org scoped lookup (tested in telephony suite)',
  'PATCH /v1/phone-numbers/:id': 'org scoped assignment (tested in telephony suite)',
  'DELETE /v1/phone-numbers/:id': 'org scoped release (tested in telephony suite)',
  'POST /v1/telephony/:provider/webhook': 'signature and number lookup scoped by provider number',
  'POST /v1/telephony/outbound': 'outbound calls are org scoped (tested in telephony suite)',
  'POST /v1/calls/:id/say': 'call-scoped control is tenant isolated (tested in call control suite)',
  'POST /v1/calls/:id/context': 'call-scoped control is tenant isolated (tested in call control suite)',
  'POST /v1/calls/:id/mute': 'call-scoped control is tenant isolated (tested in call control suite)',
  'POST /v1/calls/:id/end': 'call-scoped control is tenant isolated (tested in call control suite)',
  'POST /v1/calls/:id/transfer': 'call-scoped control is tenant isolated (tested in call control suite)',
  'GET /v1/calls/:id': 'call status is tenant isolated (tested in call control suite)',
  'GET /v1/calls/:id/live': 'live listener is tenant isolated (tested in call control suite)',
  'GET /v1/calls/:id/connect': 'media socket: org comes from the single-use call token, origin-bound (tested in browser call suite)',
  'OPTIONS /v1/calls': 'CORS preflight, no data (tested in browser call suite)',
  'GET /sdk/:file': 'public SDK bundle, no data (tested in browser call suite)',
  'POST /v1/chat': 'creates sessions in own org; continuing a session of another org is 404 (tested in chat suite)',
  'OPTIONS /v1/chat': 'CORS preflight, no data (tested in chat suite)',
  'GET /v1/chat/sessions/:id': 'org scoped lookup (tested in chat suite)',
  'POST /v1/chat/sessions/:id/end': 'org scoped end (tested in chat suite)',
  'POST /v1/chat/completions': 'assistants and sessions of own org only (tested in chat suite)',
  'POST /v1/messaging/:provider/webhook': 'signed; the receiving number decides the org (tested in SMS suite)',
  'POST /v1/squads': 'creates in own org only (tested in squad suite)',
  'GET /v1/squads': 'lists only own org squads (tested in squad suite)',
  'GET /v1/squads/:id': 'org scoped lookup (tested in squad suite)',
  'PATCH /v1/squads/:id': 'org scoped update (tested in squad suite)',
  'DELETE /v1/squads/:id': 'org scoped delete (tested in squad suite)',
  'POST /v1/webhooks': 'creates in own org only (tested in webhook suite)',
  'GET /v1/webhooks': 'lists only own org endpoints (tested in webhook suite)',
  'PATCH /v1/webhooks/:id': 'org scoped update (tested in webhook suite)',
  'DELETE /v1/webhooks/:id': 'org scoped delete (tested in webhook suite)',
  'GET /v1/webhook-deliveries': 'lists only own org deliveries (tested in webhook suite)',
  'POST /v1/webhook-deliveries/:id/redeliver': 'org scoped redelivery (tested in webhook suite)',
  'POST /v1/campaigns': 'creates in own org only; foreign assistants and numbers are refused (tested in campaign suite)',
  'GET /v1/campaigns': 'lists only own org campaigns (tested in campaign suite)',
  'GET /v1/campaigns/:id': 'org scoped lookup (tested in campaign suite)',
  'PATCH /v1/campaigns/:id': 'org scoped update (tested in campaign suite)',
  'DELETE /v1/campaigns/:id': 'org scoped delete (tested in campaign suite)',
  'POST /v1/campaigns/:id/start': 'org scoped control (tested in campaign suite)',
  'POST /v1/campaigns/:id/pause': 'org scoped control (tested in campaign suite)',
  'POST /v1/campaigns/:id/resume': 'org scoped control (tested in campaign suite)',
  'POST /v1/campaigns/:id/cancel': 'org scoped control (tested in campaign suite)',
  'POST /v1/campaigns/:id/contacts': 'uploads into own org campaigns only (tested in campaign suite)',
  'GET /v1/campaigns/:id/contacts': 'org scoped listing (tested in campaign suite)',
  'GET /v1/campaigns/:id/stats': 'org scoped statistics (tested in campaign suite)',
  'GET /v1/campaigns/:id/export.csv': 'org scoped export (tested in campaign suite)',
  'GET /v1/do-not-call': 'each org has its own list (tested in campaign suite)',
  'POST /v1/do-not-call': 'adds to own org list only (tested in campaign suite)',
  'DELETE /v1/do-not-call/:number': 'removes from own org list only (tested in campaign suite)',
  'POST /v1/telephony/:provider/status/:attemptId': 'signed; the org comes from the attempt it names (tested in campaign suite)',
  'POST /v1/structured-outputs': 'creates in own org only (tested in call analysis suite)',
  'GET /v1/structured-outputs': 'lists only own org definitions (tested in call analysis suite)',
  'GET /v1/structured-outputs/:id': 'org scoped lookup (tested in call analysis suite)',
  'PATCH /v1/structured-outputs/:id': 'org scoped update (tested in call analysis suite)',
  'DELETE /v1/structured-outputs/:id': 'org scoped delete (tested in call analysis suite)',
  'GET /v1/calls': 'lists only own org calls, with filters (tested in call analysis suite)',
  'GET /v1/calls/:id/analysis': 'org scoped lookup (tested in call analysis suite)',
  'POST /v1/calls/:id/analysis': 'org scoped re-run (tested in call analysis suite)',
  'GET /v1/transcripts/search': 'searches only own org transcripts (tested in call analysis suite)',
  'GET /v1/calls/:id/debug': 'org scoped lookup (tested in observability suite)',
  'GET /v1/providers': 'static provider catalog, the same for every org; no org data (tested in assistant suite)',
  'GET /v1/boards/overview': 'counts only own org calls; foreign assistant filters match nothing (tested in observability suite)',
  'GET /v1/boards/series': 'counts only own org calls (tested in observability suite)',
  'POST /v1/scorecards': 'creates in own org only; foreign references refused (tested in observability suite)',
  'GET /v1/scorecards': 'lists only own org scorecards (tested in observability suite)',
  'GET /v1/scorecards/:id': 'org scoped lookup (tested in observability suite)',
  'PATCH /v1/scorecards/:id': 'org scoped update (tested in observability suite)',
  'DELETE /v1/scorecards/:id': 'org scoped delete (tested in observability suite)',
  'GET /v1/scorecards/:id/value': 'org scoped lookup over own calls (tested in observability suite)',
  'GET /v1/scorecards/:id/series': 'org scoped lookup over own calls (tested in observability suite)',
  'POST /v1/alert-policies': 'creates in own org only; foreign scorecards, assistants and members refused (tested in observability suite)',
  'GET /v1/alert-policies': 'lists only own org policies (tested in observability suite)',
  'GET /v1/alert-policies/:id': 'org scoped lookup (tested in observability suite)',
  'PATCH /v1/alert-policies/:id': 'org scoped update (tested in observability suite)',
  'DELETE /v1/alert-policies/:id': 'org scoped delete (tested in observability suite)',
  'POST /v1/alert-policies/:id/test': 'org scoped dry run (tested in observability suite)',
  'GET /v1/alert-events': 'lists only own org alerts (tested in observability suite)',
  'GET /health': 'public, no data',
  'GET /ready': 'public, no org data (tested in observability suite)',
  'GET /metrics': 'operator token only; bounded labels, no org data (tested in observability suite)',
};

describe('isolation coverage', () => {
  it('every registered route has an isolation case', () => {
    const registered = t.routes.map((r) => `${r.method} ${r.url}`);
    const missing = registered.filter((r) => !(r in COVERED));
    expect(missing, `Add an isolation test for: ${missing.join(', ')}`).toEqual([]);
    const stale = Object.keys(COVERED).filter((r) => !registered.includes(r));
    expect(stale).toEqual([]);
  });
});

describe.each([
  ['session', () => A.caller],
  ['private API key', () => aKey],
])("org A (%s) cannot touch org B's resources", (_label, callerOf) => {
  const caller = () => callerOf();

  it.each([
    ['GET', () => `/v1/api-keys/${b.keyId}`],
    ['DELETE', () => `/v1/api-keys/${b.keyId}`],
    ['GET', () => `/v1/credentials/${b.credentialId}`],
    ['DELETE', () => `/v1/credentials/${b.credentialId}`],
    ['DELETE', () => `/v1/invitations/${b.invitationId}`],
    ['PATCH', () => `/v1/members/${bMember.userId}`],
    ['DELETE', () => `/v1/members/${bMember.userId}`],
    ['PATCH', () => `/v1/members/${B.userId}`],
    ['DELETE', () => `/v1/members/${B.userId}`],
  ] as const)('%s on B resource returns 404 and changes nothing', async (method, url) => {
    const before = await snapshotB();
    const res = await caller().request(method, url(), method === 'PATCH' ? { role: 'viewer' } : undefined);
    expect(res.statusCode).toBe(404);
    expect(json(res).code).toBe('not_found');
    expect(await snapshotB()).toEqual(before);
  });

  it("lists contain none of B's data", async () => {
    const lists = await Promise.all(['/v1/api-keys', '/v1/credentials', '/v1/invitations', '/v1/members', '/v1/audit-logs?limit=100'].map((u) => caller().request('GET', u)));
    for (const res of lists) {
      expect(res.statusCode).toBe(200);
      const text = res.body;
      for (const foreign of [b.keyId, b.credentialId, b.invitationId, b.invitationEmail, B.orgId, B.email, bMember.email, bMember.userId, 'B OpenAI', 'B server key']) {
        expect(text).not.toContain(foreign);
      }
    }
  });

  it('org endpoints act on A only', async () => {
    const before = await snapshotB();
    expect(json(await caller().request('GET', '/v1/org')).id).toBe(A.orgId);
    const patched = await caller().request('PATCH', '/v1/org', { name: 'Org A renamed' }, { 'x-org-id': B.orgId });
    expect(json(patched).id).toBe(A.orgId);
    expect(await snapshotB()).toEqual(before);
  });

  it('creations land in A, never in B', async () => {
    const before = await snapshotB();
    const key = json(await caller().request('POST', '/v1/api-keys', { name: 'k', type: 'private' }));
    const cred = json(await caller().request('POST', '/v1/credentials', { provider: 'cartesia', secret: 'sk_car_aaaaaaaaaaaa' }));
    const inv = json(await caller().request('POST', '/v1/invitations', { email: uniqueEmail('a-invitee'), role: 'viewer' }));
    for (const [table, id] of [['api_key', key.id], ['provider_credential', cred.id], ['invitation', inv.id]]) {
      const row = await t.db.query<{ org_id: string }>(`SELECT org_id FROM ${table} WHERE id = $1`, [id]);
      expect(row.rows[0].org_id).toBe(A.orgId);
    }
    expect(await snapshotB()).toEqual(before);
  });
});

describe('session-level isolation', () => {
  it("cannot switch into B or accept B's invitation for someone else", async () => {
    expect((await A.caller.request('PUT', '/v1/me/active-org', { orgId: B.orgId })).statusCode).toBe(404);
    const accept = await A.caller.request('POST', '/v1/invitations/accept', { token: b.invitationToken });
    expect(accept.statusCode).toBe(400);
    expect(json(await A.caller.request('GET', '/v1/me')).orgs.map((o: { id: string }) => o.id)).not.toContain(B.orgId);
  });

  it("B's API key works for B only; A's key sees A only", async () => {
    expect(json(await keyCaller(t, b.key).request('GET', '/v1/org')).id).toBe(B.orgId);
    expect(json(await aKey.request('GET', '/v1/org')).id).toBe(A.orgId);
  });

  it("a removed member loses access to the org immediately", async () => {
    const member = await addMember(t, A, 'member');
    expect((await member.caller.request('GET', '/v1/org')).statusCode).toBe(200);
    expect((await A.caller.request('DELETE', `/v1/members/${member.userId}`)).statusCode).toBe(204);
    const after = await member.caller.request('GET', '/v1/org');
    expect([403, 409]).toContain(after.statusCode);
  });
});

describe('second layer: row-level security', () => {
  it('a query that forgets its org filter still only sees its own org', async () => {
    const tables = ['org', 'membership', 'invitation', 'api_key', 'provider_credential', 'audit_log', 'idempotency_key', 'assistant', 'assistant_version', 'call', 'tool', 'call_tool_call', 'phone_number', 'call_event', 'call_transcript', 'squad', 'squad_member', 'call_member_turn', 'campaign', 'campaign_phone_number', 'campaign_contact', 'campaign_attempt', 'do_not_call', 'structured_output', 'call_analysis', 'call_debug_body', 'scorecard', 'alert_policy', 'alert_event', 'alert_notification'];
    for (const table of tables) {
      const rows = await t.ctx.tenants.withOrg(A.orgId, async (tx) => (await tx.query<{ org: string }>(`SELECT ${table === 'org' ? 'id' : 'org_id'}::text AS org FROM ${table}`)).rows);
      for (const row of rows) expect(row.org, table).toBe(A.orgId);
    }
    const allKeys = await t.db.query('SELECT 1 FROM api_key');
    expect(allKeys.rowCount).toBeGreaterThan((await t.ctx.tenants.withOrg(A.orgId, (tx) => tx.query('SELECT 1 FROM api_key'))).rowCount);
  });

  it('cannot write rows into another org, and cannot rewrite audit history', async () => {
    const insert = t.ctx.tenants.withOrg(A.orgId, (tx) =>
      tx.query(`INSERT INTO provider_credential (id, org_id, provider, label, masked, encrypted) VALUES (gen_random_uuid(), $1, 'openai', 'x', 'x', '{}')`, [B.orgId])
    );
    await expect(insert).rejects.toThrow(/row-level security/);
    const update = await t.ctx.tenants.withOrg(A.orgId, (tx) => tx.query(`UPDATE api_key SET name = 'hijacked' WHERE org_id = $1`, [B.orgId]));
    expect(update.rowCount).toBe(0);
    await expect(t.ctx.tenants.withOrg(A.orgId, (tx) => tx.query('DELETE FROM audit_log WHERE org_id = $1', [A.orgId]))).rejects.toThrow(/permission denied/);
    await expect(t.ctx.tenants.withOrg(A.orgId, (tx) => tx.query('SELECT password_hash FROM app_user'))).rejects.toThrow(/permission denied/);
  });
});

describe('deleting an org', () => {
  it("removes only that org's data", async () => {
    const victim = await signUp(t, { orgName: 'Short-lived' });
    await createKey(victim.caller);
    const before = await snapshotB();
    const res = await victim.caller.request('DELETE', '/v1/org', { confirm: 'delete' });
    expect(res.statusCode).toBe(204);
    expect((await t.db.query('SELECT 1 FROM org WHERE id = $1', [victim.orgId])).rowCount).toBe(0);
    expect((await t.db.query('SELECT 1 FROM api_key WHERE org_id = $1', [victim.orgId])).rowCount).toBe(0);
    expect(await snapshotB()).toEqual(before);
    expect(json(await A.caller.request('GET', '/v1/org')).id).toBe(A.orgId);
  });
});
