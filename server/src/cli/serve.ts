// Usage: npm run serve -- [--db data/gh.sqlite]   (PORT env var, default 3001)
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';
import { openDb } from '../db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 ? resolve(args[dbFlag + 1]!) : resolve(ROOT, 'data/gh.sqlite');

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run \`npm run ingest\` first.`);
  process.exit(1);
}
const db = openDb(dbPath);
const port = Number(process.env.PORT ?? 3001);
createApp(db).listen(port, () => console.log(`API listening on http://localhost:${port}`));
