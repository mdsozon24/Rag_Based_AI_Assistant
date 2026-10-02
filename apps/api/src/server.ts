/**
 * API server entrypoint: npm run api:dev
 * Applies pending migrations, then listens on API_HOST:API_PORT.
 */
import 'dotenv/config';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';

const config = loadConfig();
const db = await openDatabase(config.databaseUrl);
const applied = await migrate(db);
const { app, ctx } = await buildApp({ config, db });
if (applied.length) app.log.info({ migrations: applied }, 'migrations applied');
await app.listen({ host: config.host, port: config.port });
if (config.campaigns.dialerEnabled) ctx.campaigns.start();
if (config.analysis.enabled) ctx.analysis.start();
if (config.webhookDelivery.enabled) ctx.webhookDelivery.start();
if (config.monitoring.enabled) ctx.monitoring.start();

// Anything that escapes is logged with its context, counted, and sent to error tracking before the process decides what to do
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
  ctx.errors.capture(reason, { source: 'process' });
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception; shutting down');
  ctx.errors.capture(err, { source: 'process' });
  void ctx.errors.flush(2000).finally(() => process.exit(1));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await ctx.errors.flush(2000);
    await db.close();
    process.exit(0);
  });
}
