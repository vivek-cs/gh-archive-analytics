// Usage: npm run serve -- [--db data/gh.sqlite]   (PORT env var, default 3001)
// Also serves the built dashboard (web/dist) when it exists, so `npm run build && npm start`
// runs everything on one port.
import express from 'express';
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
const app = createApp(db);

const dist = resolve(ROOT, 'web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  // Client-side routes (e.g. /repo/owner/name) all load the same page.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`Listening on http://localhost:${port}${existsSync(dist) ? '' : ' (API only; run `npm run build` for the dashboard)'}`));
