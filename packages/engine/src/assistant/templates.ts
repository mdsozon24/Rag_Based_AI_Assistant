/**
 * Starter templates. Choosing one creates a new assistant whose draft is a copy of the template
 * (POST /v1/assistants {"templateId": ...}); later template changes never touch existing assistants.
 * Templates are code, versioned with the platform, not database rows.
 */
import type { AssistantSpec } from './spec.ts';

export interface AssistantTemplate {
  id: string;
  name: string;
  description: string;
  spec: AssistantSpec;
}

const VOICE_STYLE =
  'This is a live voice conversation: answer in one to three short sentences, never use lists, markdown or emojis, ' +
  'ask one question at a time, and write numbers as words.';

export const ASSISTANT_TEMPLATES: readonly AssistantTemplate[] = [
  {
    id: 'customer-support',
    name: 'Customer support',
    description: 'Answers product questions, troubleshoots common problems, and offers a human hand-off when it cannot help.',
    spec: {
      language: 'en',
      firstMessage: 'Hi, thanks for calling {{company_name}} support. How can I help you today?',
      firstMessageMode: 'assistant-speaks-first',
      systemPrompt:
        'You are a friendly, patient support agent for {{company_name}}. ' +
        VOICE_STYLE +
        ' Understand the problem before suggesting a fix, and confirm whether the fix worked. ' +
        'Never invent policies, prices or order details; if you do not know, say so and offer to have a human follow up. ' +
        'When the caller is done, say a short goodbye and end the call.',
      idle: { timeoutSeconds: 10, message: 'Are you still there?', maxPrompts: 2, endMessage: 'I will let you go for now. Goodbye!' },
      endCallPhrases: ['goodbye', 'have a great day'],
      maxDurationSeconds: 900,
      variableDefaults: { company_name: 'our company' },
      analysis: { summary: { enabled: true }, successEvaluation: { enabled: true, rubric: 'pass-fail', prompt: "Was the caller's issue resolved or correctly escalated?" } },
    },
  },
  {
    id: 'appointment-booking',
    name: 'Appointment booking',
    description: 'Books, moves or cancels appointments: collects the service, preferred day and time, name and phone number, then reads the details back.',
    spec: {
      language: 'en',
      firstMessage: 'Hello, you have reached {{business_name}}. Would you like to book, change or cancel an appointment?',
      firstMessageMode: 'assistant-speaks-first',
      systemPrompt:
        'You are the scheduling assistant for {{business_name}}. Today is {{date}}. ' +
        VOICE_STYLE +
        ' Collect, one at a time: the service, the preferred day and time, the caller name and a phone number. ' +
        'Read all the details back and get a clear yes before confirming. Never promise a slot you have not confirmed.',
      idle: { timeoutSeconds: 10, message: 'Are you still there?', maxPrompts: 2 },
      endCallPhrases: ['see you then', 'goodbye'],
      maxDurationSeconds: 600,
      variableDefaults: { business_name: 'our office' },
      analysis: {
        summary: { enabled: true },
        structuredData: {
          enabled: true,
          prompt: 'Extract the appointment request.',
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['book', 'reschedule', 'cancel'] },
              service: { type: 'string' },
              requestedTime: { type: 'string', description: 'ISO 8601 date-time' },
              name: { type: 'string' },
              phone: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    id: 'lead-qualification',
    name: 'Lead qualification',
    description: 'Qualifies inbound leads (need, budget, timeline, decision maker) and offers a follow-up call with sales.',
    spec: {
      language: 'en',
      firstMessage: 'Hi, thanks for your interest in {{company_name}}. Do you have two minutes to tell me what you are looking for?',
      firstMessageMode: 'assistant-speaks-first',
      systemPrompt:
        'You qualify leads for {{company_name}}. ' +
        VOICE_STYLE +
        ' Learn, conversationally and without interrogating: what they need, their budget range, their timeline, and who decides. ' +
        'If they are a good fit, offer a follow-up call with sales. Be honest when the product is not a fit. Never pressure the caller.',
      idle: { timeoutSeconds: 8, message: 'Sorry, are you still there?', maxPrompts: 1 },
      endCallPhrases: ['talk soon', 'goodbye'],
      maxDurationSeconds: 600,
      variableDefaults: { company_name: 'our company' },
      analysis: {
        summary: { enabled: true },
        structuredData: {
          enabled: true,
          schema: {
            type: 'object',
            properties: {
              need: { type: 'string' },
              budget: { type: 'string' },
              timeline: { type: 'string' },
              decisionMaker: { type: 'boolean' },
              qualified: { type: 'boolean' },
            },
          },
        },
        successEvaluation: { enabled: true, rubric: 'numeric-scale', prompt: 'How well qualified is this lead, from 1 to 10?' },
      },
    },
  },
];

export function findTemplate(id: string): AssistantTemplate | undefined {
  return ASSISTANT_TEMPLATES.find((t) => t.id === id);
}
