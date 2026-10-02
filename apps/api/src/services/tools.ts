import type { CredentialCipher, EncryptedSecret } from '../../../../packages/engine/src/credentials/cipher.ts';
import type { ToolSpec } from '../../../../packages/engine/src/tools/schema.ts';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../http/errors.ts';

export async function requireTools(tx: Queryable, orgId: string, ids: string[], path = 'config.toolIds'): Promise<void> {
  if (!ids.length) return;
  const rows = await tx.query<{ id: string }>('SELECT id FROM tool WHERE org_id = $1 AND id = ANY($2::uuid[])', [orgId, ids]);
  const found = new Set(rows.rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ApiError('validation_error', 'The assistant references unavailable tools', { issues: missing.map((id) => ({ path, message: `Tool ${id} was not found in this organization` })) });
}

export interface ToolRow {
  id: string;
  cursor_ts: string;
  name: string;
  description: string;
  type: ToolSpec['type'];
  parameters: Record<string, unknown>;
  messages: ToolSpec['messages'];
  endpoint_url: string | null;
  timeout_ms: number;
  retries: number;
  auth: ToolSpec['auth'];
  auth_encrypted: EncryptedSecret | null;
  static_parameters: Record<string, unknown>;
  variable_aliases: Record<string, string>;
  sensitive_paths: string[];
  rejection_rules: ToolSpec['rejectionRules'];
  created_at: Date;
  updated_at: Date;
}

export const TOOL_COLUMNS = 'id, created_at::text AS cursor_ts, name, description, type, parameters, messages, endpoint_url, timeout_ms, retries, auth, auth_encrypted, static_parameters, variable_aliases, sensitive_paths, rejection_rules, created_at, updated_at';

export function toolSpecFromRow(row: ToolRow, secret?: string): ToolSpec & { authSecret?: string } {
  return {
    name: row.name,
    description: row.description,
    type: row.type,
    parameters: row.parameters,
    messages: row.messages,
    ...(row.endpoint_url ? { endpointUrl: row.endpoint_url } : {}),
    timeoutMs: row.timeout_ms,
    retries: row.retries,
    auth: row.auth,
    staticParameters: row.static_parameters,
    variableAliases: row.variable_aliases,
    sensitivePaths: row.sensitive_paths,
    rejectionRules: row.rejection_rules,
    ...(secret ? { authSecret: secret } : {}),
  };
}

/** An assistant's tools for a conversation: specs plus decrypted auth secrets by tool name. */
export async function loadToolSpecs(tx: Queryable, orgId: string, ids: string[], cipher: CredentialCipher | null): Promise<{ specs: ToolSpec[]; secrets: Record<string, string | undefined> }> {
  if (!ids.length) return { specs: [], secrets: {} };
  const rows = (await tx.query<ToolRow>(`SELECT ${TOOL_COLUMNS} FROM tool WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids])).rows;
  const secrets: Record<string, string | undefined> = {};
  const specs = rows.map((row) => {
    secrets[row.name] = row.auth_encrypted && cipher ? cipher.decrypt(row.auth_encrypted, `${orgId}:tool:${row.id}:auth`) : undefined;
    return toolSpecFromRow(row);
  });
  return { specs, secrets };
}
