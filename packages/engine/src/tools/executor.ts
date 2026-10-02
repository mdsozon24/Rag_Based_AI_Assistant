import { createHmac } from 'node:crypto';
import { validateToolArguments, type ArgumentIssue } from './arguments.ts';
import type { ToolSpec } from './schema.ts';

export interface ToolFetcher {
  (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface ToolExecutionContext {
  callId: string;
  variables?: Readonly<Record<string, string>>;
  lastUserMessage?: string;
  authSecret?: string;
  fetch?: ToolFetcher;
  now?: () => number;
  onMessage?: (stage: 'request-start' | 'request-delayed' | 'request-failed' | 'request-complete', text: string) => void;
  protect?: (value: unknown, aad: string) => unknown;
  onExecution?: (result: ToolExecutionResult, tool: ToolSpec) => void | Promise<void>;
}

export type ToolStatus = 'success' | 'failed' | 'rejected' | 'invalid-arguments' | 'not-implemented';

export interface ToolExecutionResult {
  status: ToolStatus;
  output: unknown;
  error?: string;
  latencyMs: number;
  args: Record<string, unknown>;
  loggedArgs: unknown;
  loggedOutput: unknown;
}

export async function executeTool(tool: ToolSpec, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const now = context.now ?? Date.now;
  const started = now();
  const effective = mergeArguments(tool, args, context.variables ?? {});
  const finish = (result: Omit<ToolExecutionResult, 'latencyMs' | 'args' | 'loggedArgs' | 'loggedOutput'>): ToolExecutionResult => ({
    ...result,
    latencyMs: Math.max(0, now() - started),
    args: effective,
    loggedArgs: protectSensitive(effective, tool.sensitivePaths, context, `${context.callId}:args`),
    loggedOutput: protectSensitive(result.output, tool.sensitivePaths, context, `${context.callId}:output`),
  });

  const issues = validateToolArguments(tool.parameters, effective);
  if (issues.length) return report(finish({ status: 'invalid-arguments', output: { ok: false, code: 'invalid_arguments', issues }, error: formatIssues(issues) }));
  const rejection = tool.rejectionRules.find((rule) => context.lastUserMessage?.toLocaleLowerCase().includes(rule.when.lastUserMessageContains.toLocaleLowerCase()));
  if (rejection) return report(finish({ status: 'rejected', output: { ok: false, code: 'tool_rejected', message: rejection.message }, error: rejection.message }));

  if (tool.messages.requestStart) context.onMessage?.('request-start', tool.messages.requestStart);
  if (tool.type !== 'function') return report(finish({ status: 'not-implemented', output: { ok: false, code: 'not_implemented', toolType: tool.type }, error: `${tool.type} tools need a call transport adapter` }));
  if (!context.fetch || !tool.endpointUrl) return report(finish({ status: 'failed', output: { ok: false, code: 'not_configured' }, error: 'Function tool endpoint is not configured' }));

  const body = JSON.stringify(effective);
  let lastError = 'Tool request failed';
  for (let attempt = 0; attempt <= tool.retries; attempt++) {
    if (attempt > 0 && tool.messages.requestDelayed) context.onMessage?.('request-delayed', tool.messages.requestDelayed);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tool.timeoutMs);
    const delayedTimer = tool.messages.requestDelayed ? setTimeout(() => context.onMessage?.('request-delayed', tool.messages.requestDelayed as string), tool.messages.delayedAfterMs) : undefined;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-octo-call-id': context.callId };
      if (tool.auth.type === 'bearer' && context.authSecret) headers.authorization = `Bearer ${context.authSecret}`;
      if (tool.auth.type === 'header' && context.authSecret && tool.auth.headerName) headers[tool.auth.headerName] = context.authSecret;
      if (tool.auth.type === 'hmac' && context.authSecret) headers['x-octo-signature'] = createHmac('sha256', context.authSecret).update(body).digest('hex');
      const response = await context.fetch(tool.endpointUrl, { method: 'POST', headers, body, signal: controller.signal });
      const output = await response.json();
      if (!response.ok) throw new Error(`Tool returned HTTP ${response.status}`);
      if (tool.messages.requestComplete) context.onMessage?.('request-complete', tool.messages.requestComplete);
      return report(finish({ status: 'success', output }));
    } catch (error) {
      lastError = error instanceof Error && error.name === 'AbortError' ? `Tool timed out after ${tool.timeoutMs}ms` : error instanceof Error ? error.message : 'Tool request failed';
      if (attempt === tool.retries) break;
    } finally {
      clearTimeout(timer);
      if (delayedTimer) clearTimeout(delayedTimer);
    }
  }
  if (tool.messages.requestFailed) context.onMessage?.('request-failed', tool.messages.requestFailed);
  return report(finish({ status: 'failed', output: { ok: false, code: 'tool_failed', message: lastError }, error: lastError }));

  function report(result: ToolExecutionResult): ToolExecutionResult {
    void context.onExecution?.(result, tool);
    return result;
  }
}

export async function executeTools(calls: { tool: ToolSpec; args: Record<string, unknown> }[], context: Omit<ToolExecutionContext, 'callId'> & { callId: string }): Promise<ToolExecutionResult[]> {
  return Promise.all(calls.map(({ tool, args }) => executeTool(tool, args, context)));
}

function mergeArguments(tool: ToolSpec, args: Record<string, unknown>, variables: Readonly<Record<string, string>>): Record<string, unknown> {
  const merged = { ...args };
  for (const [field, variable] of Object.entries(tool.variableAliases)) if (!Object.hasOwn(tool.staticParameters, field) && Object.hasOwn(variables, variable)) merged[field] = variables[variable];
  return { ...merged, ...tool.staticParameters };
}

function protectSensitive(value: unknown, paths: string[], context: ToolExecutionContext, aad: string): unknown {
  if (!paths.length) return value;
  const clone = structuredClone(value);
  for (const path of paths) {
    const parts = path.split('.');
    let current: any = clone;
    for (const part of parts.slice(0, -1)) current = current && typeof current === 'object' ? current[part] : undefined;
    const leaf = parts[parts.length - 1];
    if (current && typeof current === 'object' && Object.hasOwn(current, leaf)) current[leaf] = context.protect?.(current[leaf], `${aad}:${path}`) ?? '[REDACTED]';
  }
  return clone;
}

function formatIssues(issues: ArgumentIssue[]): string {
  return issues.map((issue) => `${issue.path || 'arguments'}: ${issue.message}`).join('; ');
}