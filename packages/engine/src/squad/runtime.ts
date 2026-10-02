export type SquadContextMode = 'full' | 'summary' | 'variables';

export interface SquadMemberDefinition {
  id: string;
  assistantId?: string;
  inlineConfig?: Record<string, unknown>;
  memberOverrides?: Record<string, unknown>;
  contextMode: SquadContextMode;
  contextSchema?: Record<string, unknown>;
  /** Target member id -> description shown to the LLM. */
  handoffTargets: Record<string, string>;
}

export interface SquadDefinition {
  id: string;
  members: SquadMemberDefinition[];
  maxHandoffs: number;
  overrides?: Record<string, unknown>;
}

export interface HandoffContext {
  history: { role: string; content: string }[];
  summary?: string;
  variables?: Record<string, unknown>;
}

export interface HandoffResult {
  member: SquadMemberDefinition;
  context: HandoffContext;
  handoffCount: number;
  path: string[];
}

export interface SquadState {
  currentMemberId: string;
  handoffs: number;
  path: string[];
}

export class SquadHandoffError extends Error {
  constructor(readonly code: 'not_allowed' | 'max_handoffs' | 'ping_pong' | 'unknown_member' | 'invalid_variables', message: string) { super(message); this.name = 'SquadHandoffError'; }
}

export class SquadSession {
  private currentIndex = 0;
  private handoffs = 0;
  private path: string[];
  private readonly history: { role: string; content: string }[] = [];

  constructor(readonly squad: SquadDefinition, initialHistory: { role: string; content: string }[] = []) {
    if (!squad.members.length) throw new Error('A squad needs at least one member');
    if (squad.members.some((member) => !member.id)) throw new Error('Every squad member needs an id');
    this.history = [...initialHistory];
    this.path = [squad.members[0].id];
  }

  /** Where the squad is, for conversations that outlive one process (chat sessions). */
  toState(): SquadState { return { currentMemberId: this.current.id, handoffs: this.handoffs, path: [...this.path] }; }

  /** Continue a squad from toState(); an unknown member (squad edited since) restarts at the first one. */
  static restore(squad: SquadDefinition, state: SquadState | null | undefined): SquadSession {
    const session = new SquadSession(squad);
    const index = state ? squad.members.findIndex((member) => member.id === state.currentMemberId) : -1;
    if (state && index >= 0) {
      session.currentIndex = index;
      session.handoffs = state.handoffs;
      session.path = [...state.path];
    }
    return session;
  }

  get current(): SquadMemberDefinition { return this.squad.members[this.currentIndex]; }
  get handoffCount(): number { return this.handoffs; }
  get memberPath(): string[] { return [...this.path]; }

  async handoff(targetId: string, input: { summary?: string; variables?: Record<string, unknown>; history?: { role: string; content: string }[] }): Promise<HandoffResult> {
    const targetIndex = this.squad.members.findIndex((member) => member.id === targetId);
    if (targetIndex < 0) throw new SquadHandoffError('unknown_member', `Unknown squad member "${targetId}"`);
    if (!Object.hasOwn(this.current.handoffTargets, targetId)) throw new SquadHandoffError('not_allowed', `${this.current.id} cannot hand off to ${targetId}`);
    if (this.handoffs >= this.squad.maxHandoffs) throw new SquadHandoffError('max_handoffs', 'Maximum squad handoffs reached');
    if (this.path.length >= 2 && this.path[this.path.length - 2] === targetId) throw new SquadHandoffError('ping_pong', 'Handoff rejected to prevent assistant ping-pong');
    const target = this.squad.members[targetIndex];
    const context = this.contextFor(target, input);
    this.currentIndex = targetIndex;
    this.handoffs++;
    this.path.push(target.id);
    return { member: target, context, handoffCount: this.handoffs, path: [...this.path] };
  }

  private contextFor(target: SquadMemberDefinition, input: { summary?: string; variables?: Record<string, unknown>; history?: { role: string; content: string }[] }): HandoffContext {
    const history = input.history ?? this.history;
    if (target.contextMode === 'full') return { history: [...history], ...(input.variables ? { variables: input.variables } : {}) };
    if (target.contextMode === 'variables') {
      const variables = input.variables ?? {};
      if (target.contextSchema?.required && Array.isArray(target.contextSchema.required)) for (const name of target.contextSchema.required) if (typeof name === 'string' && !Object.hasOwn(variables, name)) throw new SquadHandoffError('invalid_variables', `Missing handoff variable ${name}`);
      return { history: [], variables };
    }
    return { history: [], summary: input.summary ?? summarize(history), ...(input.variables ? { variables: input.variables } : {}) };
  }
}

function summarize(history: { role: string; content: string }[]): string { return history.slice(-8).map((entry) => `${entry.role}: ${entry.content}`).join('\n'); }