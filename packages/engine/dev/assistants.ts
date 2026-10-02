/**
 * Assistant presets for the local voice dev server. In the platform these come from the
 * assistants API (Phase 4).
 */
import type { AssistantConfigInput } from '../src/engine/config.ts';

const shared: AssistantConfigInput = {
  endpointing: { silenceMs: 600 },
  idle: { timeoutMs: 12000, maxPrompts: 2 },
  maxDurationMs: 10 * 60 * 1000,
  tools: { endCall: { enabled: true } },
};

export const DEV_ASSISTANTS: Record<string, AssistantConfigInput> = {
  bn: {
    ...shared,
    name: 'Octo Bangla demo',
    language: 'bn',
    systemPrompt:
      'You are a friendly Bangladeshi voice assistant speaking natural, conversational Bangla. ' +
      'This is a live phone-style voice conversation: answer in one to three short sentences, never use lists, ' +
      'markdown, emojis or headings, and write numbers as words. Ask one question at a time. ' +
      'When the caller says goodbye or that they are done, say a short goodbye and call the endCall tool.',
    firstMessage: { mode: 'assistant-speaks-first', text: 'আসসালামু আলাইকুম। আপনাকে আন্তরিক স্বাগতম। আমি কীভাবে আপনাকে সাহায্য করতে পারি?' },
    idle: { ...shared.idle, message: 'আপনি কি এখনও লাইনে আছেন?', endMessage: 'ঠিক আছে, পরে আবার কথা হবে। ধন্যবাদ।' },
    fallback: { message: 'দুঃখিত, এই মুহূর্তে একটি কারিগরি সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।' },
  },
  en: {
    ...shared,
    name: 'Octo English demo',
    language: 'en',
    systemPrompt:
      'You are a friendly voice assistant. This is a live voice conversation: answer in one to three short sentences, ' +
      'never use lists, markdown or emojis, and ask one question at a time. ' +
      'When the caller says goodbye or that they are done, say a short goodbye and call the endCall tool.',
    firstMessage: { mode: 'assistant-speaks-first', text: 'Hi, this is Octo. How can I help you today?' },
    idle: { ...shared.idle, message: 'Are you still there?', endMessage: "Okay, I'll let you go. Goodbye!" },
    fallback: { message: "Sorry, I'm having technical difficulties right now. Please try again in a moment." },
  },
};
