/**
 * Role-based access control: the permission matrix, in one place.
 *
 * Roles belong to a user's membership in an org. API keys get a fixed permission set:
 * private keys act like an admin (full server access to the org, but they cannot delete the org
 * or change who owns it); public keys can only start web calls and web chats.
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

/** Rows: permission. Columns: which roles have it. */
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
  // Create, edit, publish, roll back, delete
  'assistants:read': ['owner', 'admin', 'member', 'viewer'],
  'assistants:manage': ['owner', 'admin', 'member'],
  'calls:read': ['owner', 'admin', 'member', 'viewer'],
  'calls:create': ['owner', 'admin', 'member'],
  // Text conversations: POST /v1/chat, /v1/chat/completions
  'chat:read': ['owner', 'admin', 'member', 'viewer'],
  'chat:create': ['owner', 'admin', 'member'],
  // Campaigns, their contacts, results and the do-not-call list (listing and adding numbers)
  'campaigns:read': ['owner', 'admin', 'member', 'viewer'],
  'campaigns:manage': ['owner', 'admin', 'member'],
  // Taking a number off the do-not-call list is a compliance decision: admins only
  'dnc:remove': ['owner', 'admin'],
  // Scorecards and alert policies. Policies notify people, so only admins define them
  'monitoring:read': ['owner', 'admin', 'member', 'viewer'],
  'monitoring:manage': ['owner', 'admin'],
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_MATRIX) as Permission[];

export function permissionsForRole(role: Role): Set<Permission> {
  return new Set(ALL_PERMISSIONS.filter((p) => PERMISSION_MATRIX[p].includes(role)));
}

/** Private API keys: everything an admin can do. */
export const PRIVATE_KEY_PERMISSIONS: ReadonlySet<Permission> = permissionsForRole('admin');

/** Public API keys: only starting web calls and web chats (from allowed origins, for allowed assistants). */
export const PUBLIC_KEY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['calls:create', 'chat:create']);

/** Can `actor` assign or remove `target` role? Only owners touch owners. */
export function canManageRole(actor: Role | 'api_key', target: Role): boolean {
  if (target === 'owner') return actor === 'owner';
  return actor === 'owner' || actor === 'admin' || actor === 'api_key';
}
