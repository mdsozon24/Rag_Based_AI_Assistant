import { z } from 'zod';

export const TOOL_TYPES = ['function', 'endCall', 'transferCall', 'dtmf', 'query', 'handoff', 'mcp'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

export const toolMessagesSchema = z.object({
  requestStart: z.string().max(500).optional(),
  requestDelayed: z.string().max(500).optional(),
  delayedAfterMs: z.number().int().min(100).max(120_000).default(5_000),
  requestFailed: z.string().max(500).optional(),
  requestComplete: z.string().max(500).optional(),
}).strict();

export const rejectionRuleSchema = z.object({
  when: z.object({ lastUserMessageContains: z.string().min(1).max(200) }).strict(),
  message: z.string().min(1).max(500),
}).strict();

export const toolAuthSchema = z.object({ type: z.enum(['none', 'bearer', 'header', 'hmac']).default('none'), headerName: z.string().regex(/^[A-Za-z0-9-]+$/).optional() }).strict();

export const toolSpecSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  description: z.string().trim().min(1).max(5000),
  type: z.enum(TOOL_TYPES),
  parameters: z.record(z.unknown()),
  messages: toolMessagesSchema.default({}),
  endpointUrl: z.string().url().max(2048).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(20_000),
  retries: z.number().int().min(0).max(2).default(0),
  auth: toolAuthSchema.default({}),
  staticParameters: z.record(z.unknown()).default({}),
  variableAliases: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).default({}),
  sensitivePaths: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).max(100).default([]),
  rejectionRules: z.array(rejectionRuleSchema).max(20).default([]),
}).strict().superRefine((tool, ctx) => {
  if (tool.type === 'function' && !tool.endpointUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endpointUrl'], message: 'Required for function tools' });
  if (tool.type !== 'function' && tool.endpointUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endpointUrl'], message: 'Only function tools may have an endpointUrl' });
  if (tool.auth.type !== 'none' && tool.type !== 'function') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth'], message: 'Auth is only supported for function tools' });
  if (tool.auth.type === 'header' && !tool.auth.headerName) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth.headerName'], message: 'Required for header auth' });
});

export type ToolSpec = z.infer<typeof toolSpecSchema>;

export interface ToolIssue { path: string; message: string }

export function validateToolSpec(input: unknown): { ok: true; spec: ToolSpec } | { ok: false; issues: ToolIssue[] } {
  const result = toolSpecSchema.safeParse(input);
  if (result.success) {
    if (result.data.parameters.type !== undefined && result.data.parameters.type !== 'object') return { ok: false, issues: [{ path: 'parameters.type', message: 'Tool parameters must be an object schema' }] };
    return { ok: true, spec: result.data };
  }
  return { ok: false, issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
}