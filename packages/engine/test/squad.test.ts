import { describe, expect, it } from 'vitest';
import { SquadSession, type SquadDefinition } from '../src/squad/runtime.ts';

const squad = (contextMode: 'full' | 'summary' | 'variables' = 'summary'): SquadDefinition => ({ id: 'bd-support', maxHandoffs: 3, members: [
  { id: 'receptionist', contextMode: 'summary', handoffTargets: { booking: 'Use when caller needs an appointment' } },
  { id: 'booking', contextMode, contextSchema: { required: ['name', 'reason'] }, handoffTargets: { billing: 'Use for payment questions' } },
  { id: 'billing', contextMode: 'full', handoffTargets: { booking: 'Return only when the issue is not billing' } },
] });

describe('squad handoffs', () => {
  it.each(['full', 'summary', 'variables'] as const)('passes %s context', async (mode) => {
    const session = new SquadSession(squad(mode), [{ role: 'user', content: 'I need an appointment' }]);
    const result = await session.handoff('booking', { summary: 'Caller needs booking', variables: { name: 'Rahim', reason: 'renewal' }, history: [{ role: 'user', content: 'full history' }] });
    expect(result.member.id).toBe('booking');
    if (mode === 'full') expect(result.context.history).toHaveLength(1);
    if (mode === 'summary') expect(result.context.summary).toBe('Caller needs booking');
    if (mode === 'variables') expect(result.context.variables).toEqual({ name: 'Rahim', reason: 'renewal' });
  });

  it('blocks unauthorized, ping-pong, and excessive handoffs', async () => {
    const session = new SquadSession(squad(), []);
    await session.handoff('booking', {});
    await session.handoff('billing', {});
    await expect(session.handoff('booking', {})).rejects.toMatchObject({ code: 'ping_pong' });
    const limited = new SquadSession({ ...squad(), maxHandoffs: 1 }, []);
    await limited.handoff('booking', {});
    await expect(limited.handoff('billing', {})).rejects.toMatchObject({ code: 'max_handoffs' });
  });

  it('requires declared extracted variables', async () => {
    await expect(new SquadSession(squad('variables'), []).handoff('booking', { variables: { name: 'Rahim' } })).rejects.toMatchObject({ code: 'invalid_variables' });
  });
});