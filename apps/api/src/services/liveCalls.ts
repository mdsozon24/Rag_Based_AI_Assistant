export type TransferMode = 'cold' | 'warm';
export type TransferFailureAction = 'return-to-agent' | 'take-message' | 'end';

export interface LiveCallHandle {
  say(message: string): Promise<void>;
  injectContext(context: string): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  end(reason: string): Promise<void>;
  transfer(destination: string, options: { mode: TransferMode; summary?: string; failureAction: TransferFailureAction }): Promise<void>;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
}

export class LiveCallRegistry {
  private readonly handles = new Map<string, LiveCallHandle>();
  register(callId: string, handle: LiveCallHandle): () => void { this.handles.set(callId, handle); return () => this.handles.delete(callId); }
  get(callId: string): LiveCallHandle | undefined { return this.handles.get(callId); }
}