import type { ToolExecutionResult } from '../../../../packages/engine/src/tools/executor.ts';
import type { Queryable } from '../db/database.ts';
import { newId } from '../auth/crypto.ts';

export async function recordToolCall(tx: Queryable, orgId: string, callId: string, toolId: string | null, toolName: string, result: ToolExecutionResult): Promise<void> {
  await tx.query(
    `INSERT INTO call_tool_call (id, org_id, call_id, tool_id, tool_name, status, args_encrypted, response_encrypted, error, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId(), orgId, callId, toolId, toolName, result.status, JSON.stringify(result.loggedArgs), JSON.stringify(result.loggedOutput), result.error ?? null, result.latencyMs]
  );
}