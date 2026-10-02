/**
 * Call state machine. Every transition is validated and timestamped.
 *
 *   connecting ──► listening ◄──► thinking ──► speaking ──► listening
 *        │             │  ▲            │           │
 *        └──► speaking ┘  └────────────┴───────────┘   (barge-in / user kept talking)
 *   any non-ended state ──► transferring ──► ended
 *   any non-ended state ──► ended
 */

export type CallState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'transferring' | 'ended';

export const CALL_STATES: readonly CallState[] = ['connecting', 'listening', 'thinking', 'speaking', 'transferring', 'ended'];

const TRANSITIONS: Record<CallState, readonly CallState[]> = {
  connecting: ['listening', 'speaking', 'ended'],
  // listening -> speaking: first message, idle reminder or fallback message
  listening: ['thinking', 'speaking', 'transferring', 'ended'],
  // thinking -> listening: empty transcript, or the user kept talking
  thinking: ['speaking', 'listening', 'transferring', 'ended'],
  // speaking -> thinking is not allowed: a new turn always starts from listening
  speaking: ['listening', 'transferring', 'ended'],
  transferring: ['ended'],
  ended: [],
};

export interface StateChange {
  from: CallState;
  to: CallState;
  at: number;
  reason?: string;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: CallState,
    readonly to: CallState
  ) {
    super(`Invalid call state transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: CallState, to: CallState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class CallStateMachine {
  private current: CallState = 'connecting';
  readonly history: StateChange[] = [];
  /** First time each state was entered. */
  readonly enteredAt: Partial<Record<CallState, number>> = {};

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onChange?: (change: StateChange) => void
  ) {
    this.enteredAt.connecting = now();
  }

  get state(): CallState {
    return this.current;
  }

  get isEnded(): boolean {
    return this.current === 'ended';
  }

  is(...states: CallState[]): boolean {
    return states.includes(this.current);
  }

  /** Move to `to`; throws InvalidTransitionError on an illegal move. Same-state moves are no-ops. */
  transition(to: CallState, reason?: string): StateChange | null {
    if (to === this.current) return null;
    if (!canTransition(this.current, to)) throw new InvalidTransitionError(this.current, to);
    const change: StateChange = { from: this.current, to, at: this.now(), ...(reason ? { reason } : {}) };
    this.current = to;
    this.history.push(change);
    this.enteredAt[to] ??= change.at;
    this.onChange?.(change);
    return change;
  }
}
