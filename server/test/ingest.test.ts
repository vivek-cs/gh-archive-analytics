import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ingestFile, ingestLines } from '../src/ingest.js';
import { dump, line, memDb, prComment, prEvent, review, ts } from './helpers.js';

const prRow = (db: ReturnType<typeof memDb>, number: number) =>
  db.prepare('SELECT * FROM pull_requests WHERE number = ?').get(number) as Record<string, unknown>;

describe('deduplication', () => {
  it('counts duplicate ids within one input separately from conflicting copies', async () => {
    const a = line('WatchEvent', '2026-08-01T00:00:00Z', { action: 'started' }, { id: 1 });
    const conflicting = line('WatchEvent', '2026-08-01T00:00:09Z', { action: 'started' }, { id: 1 });
    const db = memDb();
    const s = await ingestLines(db, [a, a, conflicting]);
    expect(s).toMatchObject({ lines: 3, inserted: 1, duplicateInInput: 2, duplicateConflicts: 1, alreadyStored: 0 });
    expect(db.prepare('SELECT created_at FROM events').pluck().get()).toBe(ts('2026-08-01T00:00:00Z'));
  });

  it('reports events stored by an earlier run as alreadyStored, and changes nothing', async () => {
    const input = [
      prEvent('opened', 1, '2026-08-01T00:00:00Z'),
      prEvent('merged', 1, '2026-08-02T00:00:00Z'),
      line('WatchEvent', '2026-08-01T00:00:00Z', { action: 'started' }),
    ];
    const db = memDb();
    await ingestLines(db, input);
    const before = dump(db);
    const s = await ingestLines(db, input);
    expect(s).toMatchObject({ inserted: 0, alreadyStored: 3, duplicateInInput: 0, prObservationsInserted: 0 });
    expect(dump(db)).toEqual(before);
  });

  it('gives the same result when a file is split across overlapping runs', async () => {
    const input = Array.from({ length: 20 }, (_, i) =>
      prEvent(i % 2 ? 'merged' : 'opened', Math.floor(i / 2), `2026-08-01T00:00:${String(i).padStart(2, '0')}Z`));
    const once = memDb();
    await ingestLines(once, input);
    const split = memDb();
    const s1 = await ingestLines(split, input.slice(0, 12));
    const s2 = await ingestLines(split, input.slice(8));
    expect(s1.inserted + s2.inserted).toBe(20);
    expect(s2.alreadyStored).toBe(4);
    expect(dump(split)).toEqual(dump(once));
  });
});

describe('out-of-order input', () => {
  const input = [
    prEvent('opened', 1, '2026-08-01T00:00:00Z', { actor: 'bob' }),
    review(1, '2026-08-01T05:00:00Z'),
    prEvent('closed', 1, '2026-08-02T00:00:00Z'),
    prEvent('reopened', 1, '2026-08-03T00:00:00Z'),
    prEvent('merged', 1, '2026-08-04T00:00:00Z'),
    prEvent('opened', 2, '2026-08-01T00:00:00Z'),
    prEvent('closed', 2, '2026-08-02T00:00:00Z'),
    prEvent('reopened', 2, '2026-08-03T00:00:00Z'),
    prComment(3, '2026-08-05T00:00:00Z', { state: 'open', created_at: '2026-07-20T00:00:00Z' }),
    prEvent('closed', 3, '2026-08-06T00:00:00Z'),
    line('WatchEvent', '2026-08-01T00:00:00Z', { action: 'started' }, { repo: { id: 2, name: 'old/name' } }),
    line('WatchEvent', '2026-08-09T00:00:00Z', { action: 'started' }, { repo: { id: 2, name: 'new/name' } }),
  ];

  // Deterministic shuffles (seeded LCG) so failures are reproducible.
  function shuffle<T>(xs: T[], seed: number): T[] {
    const out = [...xs];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  it('produces identical tables for every input order', async () => {
    const ref = memDb();
    await ingestLines(ref, input);
    const expected = dump(ref);
    for (const seed of [1, 2, 3, 42, 99]) {
      const db = memDb();
      await ingestLines(db, shuffle(input, seed));
      expect(dump(db)).toEqual(expected);
    }
    await ingestLines(ref, [...input].reverse());
    expect(dump(ref)).toEqual(expected);
  });

  it('resolves state from event time, not arrival order', async () => {
    const db = memDb();
    await ingestLines(db, [...input].reverse());
    expect(prRow(db, 1)).toMatchObject({ state: 'merged', merged_at: ts('2026-08-04T00:00:00Z'), author: 'bob' });
    expect(prRow(db, 2)).toMatchObject({ state: 'open', closed_at: null });
    expect(prRow(db, 3)).toMatchObject({ state: 'closed', closed_at: ts('2026-08-06T00:00:00Z') });
    expect(db.prepare('SELECT name FROM repos WHERE id = 2').pluck().get()).toBe('new/name');
  });
});

describe('PR lifecycle reconstruction', () => {
  it('keeps observed state, lifecycle times and last-seen time separate', async () => {
    const db = memDb();
    await ingestLines(db, [
      // Created before the window; we only learn that from a later comment's payload.
      prComment(5, '2026-08-10T00:00:00Z', { state: 'open', created_at: '2026-07-15T00:00:00Z', user: 'dana', title: 'Old' }),
      prComment(5, '2026-08-12T00:00:00Z', { state: 'open', created_at: '2026-07-15T00:00:00Z', user: 'dana', title: 'New' }),
      review(5, '2026-08-14T00:00:00Z'),
    ]);
    expect(prRow(db, 5)).toMatchObject({
      state: 'open',
      state_observed_at: ts('2026-08-12T00:00:00Z'), // the review carried no state
      created_at: ts('2026-07-15T00:00:00Z'),        // from payload, not first sighting
      first_seen_at: ts('2026-08-10T00:00:00Z'),
      last_seen_at: ts('2026-08-14T00:00:00Z'),
      author: 'dana',
      title: 'New',
      observations: 3,
    });
  });

  it('takes merge time from the payload, not from when a comment mentioned it', async () => {
    const db = memDb();
    await ingestLines(db, [prComment(6, '2026-08-20T00:00:00Z', {
      state: 'closed', created_at: '2026-08-01T00:00:00Z',
      closed_at: '2026-08-03T00:00:00Z', merged_at: '2026-08-03T00:00:00Z',
    })]);
    expect(prRow(db, 6)).toMatchObject({
      state: 'merged',
      state_observed_at: ts('2026-08-20T00:00:00Z'),
      merged_at: ts('2026-08-03T00:00:00Z'),
      closed_at: ts('2026-08-03T00:00:00Z'),
    });
  });

  it('prefers the exact payload time when an event and a payload disagree slightly', async () => {
    const db = memDb();
    await ingestLines(db, [
      prEvent('opened', 7, '2026-08-01T00:00:05Z'),
      prEvent('merged', 7, '2026-08-03T00:00:02Z'),
      prComment(7, '2026-08-04T00:00:00Z', {
        state: 'closed', created_at: '2026-08-01T00:00:00Z', merged_at: '2026-08-03T00:00:00Z',
      }),
    ]);
    expect(prRow(db, 7)).toMatchObject({ merged_at: ts('2026-08-03T00:00:00Z'), created_at: ts('2026-08-01T00:00:00Z') });
  });

  it('treats merged as final even if a stale observation says open', async () => {
    const db = memDb();
    await ingestLines(db, [
      prEvent('merged', 8, '2026-08-03T00:00:00Z'),
      prComment(8, '2026-08-03T00:00:00Z', { state: 'open', created_at: '2026-08-01T00:00:00Z' }),
    ]);
    expect(prRow(db, 8)).toMatchObject({ state: 'merged', merged_at: ts('2026-08-03T00:00:00Z') });
  });

  it('orders by event time even when event ids disagree', async () => {
    const db = memDb();
    await ingestLines(db, [
      prEvent('reopened', 10, '2026-08-03T00:00:00Z', { id: 50 }),
      prEvent('closed', 10, '2026-08-02T00:00:00Z', { id: 51 }),
    ]);
    expect(prRow(db, 10)).toMatchObject({ state: 'open', state_observed_at: ts('2026-08-03T00:00:00Z'), closed_at: null });
  });

  it('leaves state unknown for PRs seen only through reviews or labels', async () => {
    const db = memDb();
    await ingestLines(db, [review(9, '2026-08-01T00:00:00Z'), prEvent('labeled', 9, '2026-08-02T00:00:00Z')]);
    expect(prRow(db, 9)).toMatchObject({ state: null, state_observed_at: null, created_at: null, author: null });
  });

  it('keys PRs by repo, so equal numbers in different repos stay separate', async () => {
    const db = memDb();
    await ingestLines(db, [
      prEvent('opened', 1, '2026-08-01T00:00:00Z'),
      prEvent('merged', 1, '2026-08-02T00:00:00Z', { repo: { id: 2, name: 'other/repo' } }),
    ]);
    expect(db.prepare('SELECT repo_id, state FROM pull_requests ORDER BY repo_id').all())
      .toEqual([{ repo_id: 1, state: 'open' }, { repo_id: 2, state: 'merged' }]);
  });
});

describe('real sample lines', () => {
  it('ingests one real event of every type/action without rejections', async () => {
    const path = new URL('./fixtures/real-sample.jsonl', import.meta.url).pathname;
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const db = memDb();
    const s = await ingestFile(db, path);
    expect(s).toMatchObject({ lines: lines.length, inserted: lines.length, rejected: {} });
  });
});
