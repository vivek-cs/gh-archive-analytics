// Usage: npm run ingest -- [events.jsonl] [--db data/gh.sqlite]
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { ingestFile } from '../ingest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_DB = resolve(ROOT, 'data/gh.sqlite');

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 ? resolve(args[dbFlag + 1]!) : DEFAULT_DB;
const positional = dbFlag >= 0 ? args.filter((_, i) => i !== dbFlag && i !== dbFlag + 1) : args;
const input = positional[0] ? resolve(positional[0]) : resolve(ROOT, 'events.jsonl');

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
console.log(`Ingesting ${input} -> ${dbPath}`);
const stats = await ingestFile(db, input);
db.close();
console.log(JSON.stringify(stats, null, 2));
