/** Apply pending migrations to DATABASE_URL: npm run api:migrate */
import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase } from './database.ts';
import { migrate } from './migrate.ts';

const db = await openDatabase(loadConfig().databaseUrl);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await db.close();
