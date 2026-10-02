/**
 * Which roles may do what: a copy of the API's matrix (apps/api/src/auth/permissions.ts), used only
 * to hide or disable controls a member cannot use. The API enforces it on every request; a parity
 * test (apps/api/test/dashboardParity.test.ts) fails if the two drift.
 */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  | 'members:read'
  | 'members:manage'
  | 'invitations:read'
  | 'invitations:manage'
  | 'api_keys:read'
  | 'api_keys:manage'
  | 'credentials:read'
  | 'credentials:manage'
  | 'audit:read'
  | 'assistants:read'
  | 'assistants:manage'
  | 'calls:read'
  | 'calls:create'
  | 'chat:read'
  | 'chat:create'
  | 'campaigns:read'
  | 'campaigns:manage'
  | 'dnc:remove'
  | 'monitoring:read'
  | 'monitoring:manage';

export const PERMISSION_MATRIX: Record<Permission, readonly Role[]> = {
  'org:read': ['owner', 'admin', 'member', 'viewer'],
  'org:update': ['owner', 'admin'],
  'org:delete': ['owner'],
  'members:read': ['owner', 'admin', 'member', 'viewer'],
  'members:manage': ['owner', 'admin'],
  'invitations:read': ['owner', 'admin'],
  'invitations:manage': ['owner', 'admin'],
  'api_keys:read': ['owner', 'admin', 'member'],
  'api_keys:manage': ['owner', 'admin'],
  'credentials:read': ['owner', 'admin', 'member'],
  'credentials:manage': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
  'assistants:read': ['owner', 'admin', 'member', 'viewer'],
  'assistants:manage': ['owner', 'admin', 'member'],
  'calls:read': ['owner', 'admin', 'member', 'viewer'],
  'calls:create': ['owner', 'admin', 'member'],
  'chat:read': ['owner', 'admin', 'member', 'viewer'],
  'chat:create': ['owner', 'admin', 'member'],
  'campaigns:read': ['owner', 'admin', 'member', 'viewer'],
  'campaigns:manage': ['owner', 'admin', 'member'],
  'dnc:remove': ['owner', 'admin'],
  'monitoring:read': ['owner', 'admin', 'member', 'viewer'],
  'monitoring:manage': ['owner', 'admin'],
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return role ? PERMISSION_MATRIX[permission].includes(role) : false;
}

/** Only owners grant, change or remove the owner role (the API's canManageRole). */
export function canManageRole(actor: Role, target: Role): boolean {
  if (target === 'owner') return actor === 'owner';
  return actor === 'owner' || actor === 'admin';
}
