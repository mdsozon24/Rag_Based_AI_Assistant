/**
 * RBAC: every role against every permission-guarded endpoint, expectations derived from the
 * permission matrix itself. Plus the owner-protection rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_MATRIX, PRIVATE_KEY_PERMISSIONS, type Permission, type Role } from '../src/auth/permissions.ts';
import { addMember, createKey, createTestApp, json, keyCaller, signUp, uniqueEmail, type Caller, type SignedUp, type TestApp } from './helpers.ts';

let t: TestApp;
let owner: SignedUp;
const members: Partial<Record<Role, SignedUp>> = {};
let privateKey: Caller;

beforeAll(async () => {
  t = await createTestApp();
  owner = await signUp(t);
  members.owner = owner;
  for (const role of ['admin', 'member', 'viewer'] as const) members[role] = await addMember(t, owner, role);
  privateKey = keyCaller(t, (await createKey(owner.caller)).key);
});
afterAll(async () => t.close());

/** One representative call per permission, non-destructive for the caller's own access. */
const PROBES: { permission: Permission; method: 'GET' | 'POST' | 'PATCH'; url: string; body?: () => unknown }[] = [
  { permission: 'org:read', method: 'GET', url: '/v1/org' },
  { permission: 'org:update', method: 'PATCH', url: '/v1/org', body: () => ({ name: 'Renamed by RBAC test' }) },
  { permission: 'members:read', method: 'GET', url: '/v1/members' },
  { permission: 'invitations:read', method: 'GET', url: '/v1/invitations' },
  { permission: 'invitations:manage', method: 'POST', url: '/v1/invitations', body: () => ({ email: uniqueEmail('rbac'), role: 'viewer' }) },
  { permission: 'api_keys:read', method: 'GET', url: '/v1/api-keys' },
  { permission: 'api_keys:manage', method: 'POST', url: '/v1/api-keys', body: () => ({ name: 'rbac', type: 'private' }) },
  { permission: 'credentials:read', method: 'GET', url: '/v1/credentials' },
  { permission: 'credentials:manage', method: 'POST', url: '/v1/credentials', body: () => ({ provider: 'openai', secret: 'sk-rbac-test-123456' }) },
  { permission: 'audit:read', method: 'GET', url: '/v1/audit-logs' },
  { permission: 'campaigns:read', method: 'GET', url: '/v1/campaigns' },
  { permission: 'campaigns:manage', method: 'POST', url: '/v1/do-not-call', body: () => ({ numbers: ['+8801811900001'] }) },
];

describe('permission matrix', () => {
  const cases = (['owner', 'admin', 'member', 'viewer'] as const).flatMap((role) => PROBES.map((p) => ({ role, ...p, allowed: PERMISSION_MATRIX[p.permission].includes(role) })));

  it.each(cases)('$role $method $url ($permission) -> allowed: $allowed', async ({ role, method, url, body, allowed, permission }) => {
    const res = await members[role]!.caller.request(method, url, body?.());
    if (allowed) {
      expect(res.statusCode, res.body).toBeLessThan(300);
    } else {
      expect(res.statusCode).toBe(403);
      expect(json(res)).toMatchObject({ code: 'forbidden', details: { permission, role } });
    }
  });

  it.each(PROBES)('private API key $method $url ($permission)', async ({ method, url, body, permission }) => {
    const res = await privateKey.request(method, url, body?.());
    if (PRIVATE_KEY_PERMISSIONS.has(permission)) expect(res.statusCode, res.body).toBeLessThan(300);
    else expect(res.statusCode).toBe(403);
  });

  it('only owners can delete the org; API keys cannot', async () => {
    for (const role of ['admin', 'member', 'viewer'] as const) {
      expect((await members[role]!.caller.request('DELETE', '/v1/org', { confirm: 'delete' })).statusCode).toBe(403);
    }
    expect((await privateKey.request('DELETE', '/v1/org', { confirm: 'delete' })).statusCode).toBe(403);
    expect((await owner.caller.request('DELETE', '/v1/org', {})).statusCode).toBe(400); // confirmation required
  });
});

describe('owner protections', () => {
  let org: SignedUp;
  let admin: SignedUp;
  let viewer: SignedUp;

  beforeAll(async () => {
    org = await signUp(t);
    admin = await addMember(t, org, 'admin');
    viewer = await addMember(t, org, 'viewer');
  });

  it('admins cannot grant, change or remove the owner role', async () => {
    expect((await admin.caller.request('PATCH', `/v1/members/${viewer.userId}`, { role: 'owner' })).statusCode).toBe(403);
    expect((await admin.caller.request('PATCH', `/v1/members/${org.userId}`, { role: 'viewer' })).statusCode).toBe(403);
    expect((await admin.caller.request('DELETE', `/v1/members/${org.userId}`)).statusCode).toBe(403);
    expect((await admin.caller.request('PATCH', `/v1/members/${viewer.userId}`, { role: 'member' })).statusCode).toBe(200);
  });

  it('the last owner cannot leave or step down', async () => {
    const leave = await org.caller.request('DELETE', `/v1/members/${org.userId}`);
    expect(leave.statusCode).toBe(409);
    expect((await org.caller.request('PATCH', `/v1/members/${org.userId}`, { role: 'admin' })).statusCode).toBe(409);
    // With a second owner it works
    expect((await org.caller.request('PATCH', `/v1/members/${admin.userId}`, { role: 'owner' })).statusCode).toBe(200);
    expect((await org.caller.request('PATCH', `/v1/members/${org.userId}`, { role: 'admin' })).statusCode).toBe(200);
  });

  it('members can leave on their own, but cannot remove others', async () => {
    const member = await addMember(t, admin, 'member');
    expect((await member.caller.request('DELETE', `/v1/members/${viewer.userId}`)).statusCode).toBe(403);
    expect((await member.caller.request('DELETE', `/v1/members/${member.userId}`)).statusCode).toBe(204);
  });

  it('role changes are audited', async () => {
    const changes = await t.db.query('SELECT metadata FROM audit_log WHERE org_id = $1 AND action = $2', [org.orgId, 'member.role_changed']);
    expect(changes.rowCount).toBeGreaterThanOrEqual(3);
  });
});
