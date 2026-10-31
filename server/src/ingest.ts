import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DB } from './db.js';
import { normalizeLine, type NormalizedEvent, type PrObservation } from './normalize.js';
import { rebuildPullRequests } from './prs.js';

export interface IngestStats {
  lines: number;
  blankLines: number;
  inserted: number;
  duplicateInInput: number;    // id already seen earlier in this same input
  duplicateConflicts: number;  // ...and the line content differed (first copy wins)
  alreadyStored: number;       // id was in the database before this run
  rejected: Record<string, number>;
  prObservationsInserted: number;
  pullRequests: number;
  durationMs: number;
}

const BATCH = 5000;

// Reruns are safe: every insert is keyed by event id and ignored if present, and
// pull_requests is rebuilt from scratch, so ingesting the same data twice (or in a
// different order, or split across runs) yields identical tables.
export async function ingestLines(
  db: DB,
  lines: AsyncIterable<string> | Iterable<string>,
  source = 'memory',
): Promise<IngestStats> {
  const started = new Date();
  const t0 = performance.now();
  const stats: IngestStats = {
    lines: 0, blankLines: 0, inserted: 0, duplicateInInput: 0, duplicateConflicts: 0,
    alreadyStored: 0, rejected: {}, prObservationsInserted: 0, pullRequests: 0, durationMs: 0,
  };

  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events VALUES (@id, @repoId, @type, @action, @category,
       @actorId, @actorLogin, @isBot, @createdAt, @prNumber)`,
  );
  // Keep the name from the most recent event, so renames resolve the same way in any order.
  const upsertRepo = db.prepare(
    `INSERT INTO repos VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE
       SET name = excluded.name, name_seen_at = excluded.name_seen_at
       WHERE excluded.name_seen_at > repos.name_seen_at
          OR (excluded.name_seen_at = repos.name_seen_at AND excluded.name > repos.name)`,
  );
  const insertObs = db.prepare(
    `INSERT OR IGNORE INTO pr_observations VALUES (@eventId, @repoId, @number, @observedAt,
       @source, @state, @createdAt, @closedAt, @mergedAt, @author, @title)`,
  );

  const flush = db.transaction((batch: { event: NormalizedEvent; pr: PrObservation | null }[]) => {
    for (const { event, pr } of batch) {
      const res = insertEvent.run({ ...event, isBot: event.isBot ? 1 : 0 });
      if (res.changes === 0) {
        stats.alreadyStored++;
        continue;
      }
      stats.inserted++;
      upsertRepo.run(event.repoId, event.repoName, event.createdAt);
      if (pr) stats.prObservationsInserted += insertObs.run(pr).changes;
    }
  });

  const seen = new Map<number, string>(); // id -> content hash, for in-input duplicates
  let batch: { event: NormalizedEvent; pr: PrObservation | null }[] = [];
  for await (const line of lines) {
    stats.lines++;
    if (line.trim() === '') {
      stats.blankLines++;
      continue;
    }
    const r = normalizeLine(line);
    if (!r.ok) {
      stats.rejected[r.reason] = (stats.rejected[r.reason] ?? 0) + 1;
      continue;
    }
    const hash = createHash('sha1').update(line).digest('base64');
    const prev = seen.get(r.event.id);
    if (prev !== undefined) {
      stats.duplicateInInput++;
      if (prev !== hash) stats.duplicateConflicts++;
      continue;
    }
    seen.set(r.event.id, hash);
    batch.push({ event: r.event, pr: r.pr });
    if (batch.length >= BATCH) {
      flush(batch);
      batch = [];
    }
  }
  flush(batch);

  stats.pullRequests = rebuildPullRequests(db);
  stats.durationMs = Math.round(performance.now() - t0);
  db.prepare('INSERT INTO ingest_runs (source, started_at, duration_ms, stats) VALUES (?, ?, ?, ?)')
    .run(source, started.toISOString(), stats.durationMs, JSON.stringify(stats));
  return stats;
}

export function ingestFile(db: DB, path: string): Promise<IngestStats> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  return ingestLines(db, rl, path);
}
