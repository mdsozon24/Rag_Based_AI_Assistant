/**
 * The provider catalog: which transcribers, models and voices an assistant can use, the fields each
 * accepts, the presets and the credential vendors. Read-only and the same for every org (no org
 * data). Reference: docs/API.md ("Provider catalog").
 */
import type { FastifyInstance } from 'fastify';
import { describeProviders, type ProviderCatalog } from '../../../../packages/engine/src/providers/describe.ts';
import type { AppContext } from '../context.ts';

export function registerProviderRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Derived from code, so computed once per process
  let catalog: ProviderCatalog | null = null;
  app.get('/v1/providers', { config: { permission: 'assistants:read' } }, async () => {
    catalog ??= describeProviders(ctx.voice.registry);
    return catalog;
  });
}
