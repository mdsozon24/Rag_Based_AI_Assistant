import type { ChatMessage, LanguageModel, ToolCall, ToolDefinition } from '../providers/types.ts';
import type { Logger } from '../logger.ts';
import { executeTool, type ToolExecutionContext, type ToolExecutionResult } from './executor.ts';
import type { ToolSpec } from './schema.ts';

export interface ToolTurnResult {
  text: string;
  messages: ChatMessage[];
  executions: ToolExecutionResult[];
}

/** Run the model/tool exchange without blocking the caller's transport on sequential tool calls. */
export async function runToolTurn(
  model: LanguageModel,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  context: ToolExecutionContext & { signal: AbortSignal; logger: Logger },
  maxRounds = 4
): Promise<ToolTurnResult> {
  const conversation = [...messages];
  const executions: ToolExecutionResult[] = [];
  let text = '';
  for (let round = 0; round < maxRounds; round++) {
    const calls: ToolCall[] = [];
    let responseText = '';
    for await (const event of model.stream({ systemPrompt, messages: conversation, tools: tools.map(toDefinition) }, { callId: context.callId, logger: context.logger, signal: context.signal })) {
      if (event.type === 'text') responseText += event.text;
      if (event.type === 'tool-call') calls.push(event);
    }
    text += responseText;
    if (!calls.length) return { text, messages: conversation, executions };
    conversation.push({ role: 'assistant', content: responseText, toolCalls: calls });
    const results = await Promise.all(calls.map((call) => {
      const tool = tools.find((candidate) => candidate.name === call.name);
      return tool ? executeTool(tool, call.args, context) : Promise.resolve({ status: 'failed', output: { ok: false, code: 'unknown_tool', message: `Unknown tool ${call.name}` }, error: `Unknown tool ${call.name}`, latencyMs: 0, args: call.args, loggedArgs: call.args, loggedOutput: null } satisfies ToolExecutionResult);
    }));
    executions.push(...results);
    calls.forEach((call, index) => conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[index].output) }));
  }
  return { text, messages: conversation, executions };
}

function toDefinition(tool: ToolSpec): ToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}