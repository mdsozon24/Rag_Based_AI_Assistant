/**
 * What a campaign call needs from the engine: noticing that the person does not want to be called
 * again, and recording an outcome label. The engine only reports; the API persists (do-not-call
 * list, contact outcome) through these hooks.
 */

export const OPT_OUT_TOOL = 'optOut';
export const REPORT_OUTCOME_TOOL = 'reportOutcome';

/**
 * Phrases that mean "do not call me again", matched as whole words in the caller's transcript,
 * case and punctuation ignored. Campaigns add their own on top. A false match only ever means one
 * contact fewer is called, so the list errs on the side of matching.
 */
export const DEFAULT_OPT_OUT_PHRASES: readonly string[] = [
  // English
  'stop calling',
  'do not call',
  "don't call",
  'never call',
  'do not contact',
  "don't contact",
  'stop contacting',
  'remove me',
  'take me off',
  'delete my number',
  'unsubscribe',
  'opt out',
  // Bangla
  'ফোন করবেন না',
  'কল করবেন না',
  'কল দেবেন না',
  'ফোন দেবেন না',
  'আর ফোন করবেন',
  'বিরক্ত করবেন না',
  'আমার নম্বর মুছে',
  'আমার নাম্বার মুছে',
  'তালিকা থেকে বাদ',
  'তালিকা থেকে সরিয়ে',
];

export const DEFAULT_OPT_OUT_MESSAGE = 'Understood. We will not call you again. Goodbye.';

export interface CampaignHooks {
  /** Phrases (on top of whatever the caller already put here) that end the call as an opt-out. */
  optOutPhrases: readonly string[];
  /** Spoken before hanging up on an opt-out the assistant did not already acknowledge. */
  optOutMessage: string;
  /** Labels the assistant may report with the reportOutcome tool; empty: the tool is not offered. */
  outcomeLabels: readonly string[];
  /** Awaited before the opt-out reply is spoken, so the number is on the list before the call ends. */
  onOptOut(info: { source: 'phrase' | 'tool'; text: string; phrase?: string }): void | Promise<void>;
  onOutcome(outcome: { label: string; notes?: string }): void | Promise<void>;
}
