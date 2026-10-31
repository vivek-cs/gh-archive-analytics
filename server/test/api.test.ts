import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ingestLines } from '../src/ingest.js';
import { parseBucket } from '../src/range.js';
import { line, memDb, prComment, prEvent, review } from './helpers.js';

const A = { id: 1, name: 'acme/widget' };
const B = { id: 2, name: 'other/repo' };
const C = { id: 3, name: 'zeta/quiet' };
const FILLER = { id: 9, name: 'filler/anchor' };

const star = (at: string, repo = A, actor = 'fan') => line('WatchEvent', at, { action: 'started' }, { repo, actor });
const push = (at: string, actor: string, repo = A) => line('PushEvent', at, {}, { repo, actor });

// Coverage is derived from the data: these anchors make it [Aug 1, Aug 11).
const ANCHORS = [push('2026-08-01T00:00:01Z', 'x', FILLER), push('2026-08-10T23:00:00Z', 'x', FILLER)];

async function api(lines: string[]) {
  const db = memDb();
  await ingestLines(db, [...ANCHORS, ...lines]);
  const agent = request(createApp(db));
  return async (url: string, status = 200) => {
    const res = await agent.get(url);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  };
}

describe('GET /api/trending', () => {
  it('ranks star-only repos by score, breaks ties by name, and leaves out repos with no scored activity', async () => {
    const get = await api([
      star('2026-08-05T01:00:00Z', B), star('2026-08-05T02:00:00Z', B), star('2026-08-05T03:00:00Z', B, 'fan'),
      star('2026-08-05T01:00:00Z', A), star('2026-08-05T02:00:00Z', A), star('2026-08-05T03:00:00Z', A, 'fan'),
      star('2026-08-05T04:00:00Z', C),
      push('2026-08-05T01:00:00Z', 'nostars', FILLER),
    ]);
    const body = await get('/api/trending?from=2026-08-05&to=2026-08-06');
    expect(body.total).toBe(3);
    // Stars are event counts: a repeat star by the same actor still counts.
    expect(body.items.map((x: any) => [x.rank, x.repo, x.stars])).toEqual([
      [1, 'acme/widget', 3], [2, 'other/repo', 3], [3, 'zeta/quiet', 1],
    ]);
    expect((await get('/api/trending?from=2026-08-05&to=2026-08-06&limit=1')).items).toHaveLength(1);
  });

  it('reports forks, reconstructed PRs and distinct human contributors in the range', async () => {
    const get = await api([
      star('2026-08-05T01:00:00Z', A, 'stargazer'),
      line('ForkEvent', '2026-08-05T02:00:00Z', { action: 'forked' }, { repo: A, actor: 'forker' }),
      prEvent('opened', 1, '2026-08-05T03:00:00Z', { repo: A, actor: 'bob' }),
      prEvent('merged', 1, '2026-08-05T04:00:00Z', { repo: A, actor: 'maintainer' }),
      // Created in range, known only from a later comment payload.
      prComment(2, '2026-08-07T00:00:00Z', { state: 'open', created_at: '2026-08-05T05:00:00Z' }, { repo: A, actor: 'carol' }),
      push('2026-08-05T06:00:00Z', 'bob'),
      push('2026-08-05T07:00:00Z', 'dependabot[bot]'),
      push('2026-08-06T00:00:00Z', 'tomorrow'), // outside range
    ]);
    const [item] = (await get('/api/trending?from=2026-08-05&to=2026-08-06')).items;
    expect(item).toMatchObject({
      repo: 'acme/widget', stars: 1, forks: 1, prs_opened: 2, prs_merged: 1,
      contributors: 2, // bob, maintainer; not the stargazer, forker, bot, or carol (out of range)
    });
  });

  it('treats from as inclusive and to as exclusive', async () => {
    const get = await api([
      star('2026-08-05T00:00:00Z'), star('2026-08-05T23:59:59Z'), star('2026-08-06T00:00:00Z'),
    ]);
    expect((await get('/api/trending?from=2026-08-05&to=2026-08-06')).items[0].stars).toBe(2);
    expect((await get('/api/trending?from=2026-08-05T23:59:59Z&to=2026-08-06T00:00:01Z')).items[0].stars).toBe(2);
  });

  it('compares with the preceding equal window when it is fully covered', async () => {
    const get = await api([
      star('2026-08-04T10:00:00Z'), star('2026-08-05T10:00:00Z'), star('2026-08-05T11:00:00Z'),
      star('2026-08-05T10:00:00Z', B),
    ]);
    const body = await get('/api/trending?from=2026-08-05&to=2026-08-06');
    expect(body.comparison).toEqual({ available: true, from: '2026-08-04T00:00:00Z', to: '2026-08-05T00:00:00Z' });
    expect(body.items[0]).toMatchObject({ repo: 'acme/widget', previous_stars: 1, stars_change: 1, growth_pct: 100 });
    // No stars before: the change is known but a percentage is undefined.
    expect(body.items[1]).toMatchObject({ repo: 'other/repo', previous_stars: 0, stars_change: 1, growth_pct: null });
  });

  it('returns unavailable growth when the preceding window is not covered', async () => {
    const get = await api([star('2026-08-02T10:00:00Z')]);
    const body = await get('/api/trending?from=2026-08-01&to=2026-08-03');
    expect(body.comparison).toMatchObject({ available: false, from: '2026-07-30T00:00:00Z' });
    expect(body.items[0]).toMatchObject({ stars: 1, previous_stars: null, stars_change: null, growth_pct: null });
    // Exactly at the edge: [Aug 1, Aug 3) compares with [Jul 30, Aug 1) -> unavailable,
    // but [Aug 3, Aug 5) compares with [Aug 1, Aug 3) -> available.
    expect((await get('/api/trending?from=2026-08-03&to=2026-08-05')).comparison.available).toBe(true);
  });

  it('returns an empty list, not an error, when nothing scored', async () => {
    const get = await api([]);
    expect(await get('/api/trending?from=2026-08-05&to=2026-08-06')).toMatchObject({ total: 0, items: [] });
  });
});

describe('momentum score', () => {
  const fork = (at: string, repo = A, opts: { id?: number } = {}) =>
    line('ForkEvent', at, { action: 'forked' }, { repo, actor: 'forker', ...opts });
  const issue = (action: string, at: string, repo = A, opts: { id?: number } = {}) =>
    line('IssuesEvent', at, { action, issue: { number: 1, state: 'open' } }, { repo, ...opts });
  const trending = async (lines: string[], range = 'from=2026-08-05&to=2026-08-06') =>
    (await (await api(lines))(`/api/trending?${range}`)).items;

  it('scores 3·stars + 2·forks + PRs opened + 0.5·issues opened, and ignores everything else', async () => {
    const [item] = await trending([
      star('2026-08-05T01:00:00Z'), star('2026-08-05T02:00:00Z'),                  // 2 × 3
      fork('2026-08-05T03:00:00Z'),                                                // 1 × 2
      prEvent('opened', 1, '2026-08-05T04:00:00Z'),                                // PR seen opening
      prComment(2, '2026-08-07T00:00:00Z', { state: 'open', created_at: '2026-08-05T05:00:00Z' }), // created in range
      issue('opened', '2026-08-05T06:00:00Z'), issue('opened', '2026-08-05T07:00:00Z'),
      issue('opened', '2026-08-05T08:00:00Z'),                                     // 3 × 0.5
      // Not scored: PR labels/merges/reviews, issue labels/closes/reopens, comments, pushes.
      prEvent('labeled', 1, '2026-08-05T09:00:00Z'), prEvent('merged', 1, '2026-08-05T10:00:00Z'),
      review(1, '2026-08-05T11:00:00Z'),
      issue('labeled', '2026-08-05T12:00:00Z'), issue('closed', '2026-08-05T13:00:00Z'),
      issue('reopened', '2026-08-05T14:00:00Z'),
      prComment(9, '2026-08-05T15:00:00Z', { state: 'open', created_at: '2026-07-01T00:00:00Z' }),
      push('2026-08-05T16:00:00Z', 'bob'),
    ]);
    expect(item).toMatchObject({
      repo: 'acme/widget', stars: 2, forks: 1, prs_opened: 2, issues_opened: 3, prs_merged: 1,
      score: 2 * 3 + 1 * 2 + 2 + 3 * 0.5, // 11.5
    });
  });

  it('counts each event and each PR once, however often it appears', async () => {
    const s = star('2026-08-05T01:00:00Z', A, 'fan');
    const i = issue('opened', '2026-08-05T02:00:00Z');
    const [item] = await trending([
      s, s, s, i, i,
      // One PR, seen through its opened event and two comment payloads.
      prEvent('opened', 7, '2026-08-05T03:00:00Z'),
      prEvent('opened', 7, '2026-08-05T03:00:00Z', { id: 777 }), prEvent('opened', 7, '2026-08-05T03:00:00Z', { id: 777 }),
      prComment(7, '2026-08-05T04:00:00Z', { state: 'open', created_at: '2026-08-05T03:00:00Z' }),
      prComment(7, '2026-08-05T05:00:00Z', { state: 'open', created_at: '2026-08-05T03:00:00Z' }),
    ]);
    expect(item).toMatchObject({ stars: 1, issues_opened: 1, prs_opened: 1, score: 3 + 0.5 + 1 });
  });

  it('includes events at `from` and excludes events at `to` for every component', async () => {
    const edge = (at: string, repo: typeof A) => [
      star(at, repo), fork(at, repo), issue('opened', at, repo),
      prComment(1, '2026-08-08T00:00:00Z', { state: 'open', created_at: at }, { repo }),
    ];
    const items = await trending([...edge('2026-08-05T00:00:00Z', A), ...edge('2026-08-06T00:00:00Z', B)]);
    expect(items.map((x: any) => [x.repo, x.score])).toEqual([['acme/widget', 3 + 2 + 1 + 0.5]]);
  });

  it('ranks by score, then stars, then name', async () => {
    const items = await trending([
      // B: score 6 from stars alone. A: score 6 from 1 star + 3 PRs -> B wins on stars.
      star('2026-08-05T01:00:00Z', B), star('2026-08-05T02:00:00Z', B),
      star('2026-08-05T01:00:00Z', A),
      prEvent('opened', 1, '2026-08-05T01:00:00Z'), prEvent('opened', 2, '2026-08-05T01:00:00Z'),
      prEvent('opened', 3, '2026-08-05T01:00:00Z'),
      // C and D: identical activity -> name order.
      fork('2026-08-05T01:00:00Z', { id: 4, name: 'zz/second' }), fork('2026-08-05T01:00:00Z', C),
    ]);
    expect(items.map((x: any) => [x.rank, x.repo, x.score, x.stars])).toEqual([
      [1, 'other/repo', 6, 2], [2, 'acme/widget', 6, 1], [3, 'zeta/quiet', 2, 0], [4, 'zz/second', 2, 0],
    ]);
  });

  it('lets repos without stars rank on other activity', async () => {
    const items = await trending([
      star('2026-08-05T01:00:00Z', A),                                                  // 3
      ...[1, 2, 3, 4, 5].map((n) => prEvent('opened', n, '2026-08-05T01:00:00Z', { repo: B })), // 5
      issue('opened', '2026-08-05T01:00:00Z', C),                                       // 0.5
    ]);
    expect(items.map((x: any) => [x.repo, x.score])).toEqual([['other/repo', 5], ['acme/widget', 3], ['zeta/quiet', 0.5]]);
    expect(items[0]).toMatchObject({ stars: 0, previous_stars: 0, stars_change: 0, growth_pct: null });
  });

  it('leaves out repos whose only activity is unscored', async () => {
    const get = await api([
      star('2026-08-05T01:00:00Z', A),
      issue('closed', '2026-08-05T01:00:00Z', B), issue('labeled', '2026-08-05T02:00:00Z', B),
      prEvent('labeled', 1, '2026-08-05T01:00:00Z', { repo: C }), push('2026-08-05T01:00:00Z', 'bob', C),
    ]);
    const body = await get('/api/trending?from=2026-08-05&to=2026-08-06');
    expect(body.total).toBe(1);
    expect(body.items.map((x: any) => x.repo)).toEqual(['acme/widget']);
  });

  it('describes the ranking in the response', async () => {
    const get = await api([star('2026-08-05T01:00:00Z')]);
    expect((await get('/api/trending')).ranking).toEqual({
      by: 'momentum_score',
      weights: { stars: 3, forks: 2, prs_opened: 1, issues_opened: 0.5 },
      tie_breakers: ['stars desc', 'repo asc'],
    });
  });
});

describe('pagination', () => {
  // 7 repos with distinct scores (7 stars ... 1 star), plus 5 open PRs on acme/widget.
  const repos = Array.from({ length: 7 }, (_, i) => ({ id: 100 + i, name: `org/r${i}` }));
  const lines = [
    ...repos.flatMap((r, i) => Array.from({ length: 7 - i }, (_, k) => star(`2026-08-05T0${k}:00:00Z`, r))),
    ...[1, 2, 3, 4, 5].map((n) => prEvent('opened', n, `2026-08-${String(n + 5).padStart(2, '0')}T00:00:00Z`)), // outside the trending range
  ];

  it('pages trending results with absolute ranks and no gaps or overlaps', async () => {
    const get = await api(lines);
    const page = async (offset: number) => get(`/api/trending?from=2026-08-05&to=2026-08-06&limit=3&offset=${offset}`);
    const [p1, p2, p3, p4] = await Promise.all([page(0), page(3), page(6), page(9)]);
    expect([p1, p2, p3, p4].map((p) => [p.total, p.offset, p.limit, p.max_score]))
      .toEqual([[7, 0, 3, 21], [7, 3, 3, 21], [7, 6, 3, 21], [7, 9, 3, 21]]);
    expect(p1.items.map((x: any) => [x.rank, x.repo])).toEqual([[1, 'org/r0'], [2, 'org/r1'], [3, 'org/r2']]);
    expect(p2.items.map((x: any) => [x.rank, x.repo])).toEqual([[4, 'org/r3'], [5, 'org/r4'], [6, 'org/r5']]);
    expect(p3.items.map((x: any) => [x.rank, x.repo])).toEqual([[7, 'org/r6']]); // short last page
    expect(p4.items).toEqual([]);                                                   // past the end
    const all = (await get('/api/trending?from=2026-08-05&to=2026-08-06&limit=100')).items;
    expect([...p1.items, ...p2.items, ...p3.items]).toEqual(all);
  });

  it('pages open PRs in a stable order', async () => {
    const get = await api(lines);
    const p1 = await get('/api/repos/acme/widget/pulls/open?limit=2&offset=0');
    const p3 = await get('/api/repos/acme/widget/pulls/open?limit=2&offset=4');
    expect([p1.total, p1.offset, p1.limit]).toEqual([5, 0, 2]);
    expect(p1.items.map((x: any) => x.number)).toEqual([5, 4]); // most recently seen first
    expect(p3.items.map((x: any) => x.number)).toEqual([1]);
  });
});

describe('parameter validation', () => {
  it.each([
    ['/api/trending?from=2026-08-06&to=2026-08-05', 'invalid_range'],
    ['/api/trending?from=2026-08-05&to=2026-08-05', 'invalid_range'],
    ['/api/trending?from=yesterday', 'invalid_parameter'],
    ['/api/trending?from=2026-08-05T00:00:00%2B02:00', 'invalid_parameter'],
    ['/api/trending?from=2026-02-31', 'invalid_parameter'],
    ['/api/trending?from=2026-07-31', 'range_outside_coverage'],
    ['/api/trending?to=2026-08-12', 'range_outside_coverage'],
    ['/api/trending?limit=0', 'invalid_parameter'],
    ['/api/trending?limit=101', 'invalid_parameter'],
    ['/api/trending?limit=ten', 'invalid_parameter'],
    ['/api/trending?offset=-1', 'invalid_parameter'],
    ['/api/repos/acme/widget/activity?bucket=week', 'invalid_parameter'],
    ['/api/repos/acme/widget/contributors?include_bots=maybe', 'invalid_parameter'],
    ['/api/repos/acme/widget/pulls/open?offset=-1', 'invalid_parameter'],
  ])('%s -> 400 %s', async (url, code) => {
    const get = await api([star('2026-08-05T00:00:00Z')]);
    const body = await get(url, 400);
    expect(body).toEqual({ error: { code, message: expect.any(String) } });
  });

  it('defaults the range to the full coverage', async () => {
    const get = await api([star('2026-08-05T00:00:00Z')]);
    expect((await get('/api/trending')).range).toEqual({ from: '2026-08-01T00:00:00Z', to: '2026-08-11T00:00:00Z' });
  });

  it('returns 404 for unknown repositories and endpoints', async () => {
    const get = await api([star('2026-08-05T00:00:00Z')]);
    for (const path of ['activity', 'pulls/open', 'pulls/merged', 'contributors']) {
      expect((await get(`/api/repos/no/such/${path}`, 404)).error.code).toBe('repo_not_found');
    }
    expect((await get('/api/nope', 404)).error.code).toBe('not_found');
  });

  it('matches repository names case-insensitively', async () => {
    const get = await api([star('2026-08-05T00:00:00Z')]);
    expect((await get('/api/repos/ACME/Widget/activity')).repo).toBe('acme/widget');
  });

  it('returns 503 for range queries on an empty database', async () => {
    const res = await request(createApp(memDb())).get('/api/trending');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('no_data');
  });

  it('rejects hourly ranges with too many buckets', () => {
    expect(() => parseBucket('hour', { from: 0, to: 1001 * 3600 })).toThrow(/too many buckets/);
    expect(parseBucket('auto', { from: 0, to: 72 * 3600 })).toBe(3600);
    expect(parseBucket('auto', { from: 0, to: 72 * 3600 + 1 })).toBe(86400);
  });
});

describe('GET /api/repos/:owner/:name/activity', () => {
  it('fills zero-activity days so gaps stay visible', async () => {
    const get = await api([star('2026-08-03T10:00:00Z'), push('2026-08-03T11:00:00Z', 'bob')]);
    const body = await get('/api/repos/acme/widget/activity?from=2026-08-01&to=2026-08-05');
    expect(body.bucket).toBe('day');
    expect(body.buckets.map((b: any) => [b.start, b.stars, b.pushes])).toEqual([
      ['2026-08-01T00:00:00Z', 0, 0], ['2026-08-02T00:00:00Z', 0, 0],
      ['2026-08-03T00:00:00Z', 1, 1], ['2026-08-04T00:00:00Z', 0, 0],
    ]);
    expect(Object.keys(body.buckets[0]).sort()).toEqual(['start', ...body.series].sort());
  });

  it('uses hourly buckets automatically for short ranges', async () => {
    const get = await api([star('2026-08-03T10:30:00Z')]);
    const body = await get('/api/repos/acme/widget/activity?from=2026-08-03&to=2026-08-04');
    expect(body.bucket).toBe('hour');
    expect(body.buckets).toHaveLength(24);
    expect(body.buckets[10]).toMatchObject({ start: '2026-08-03T10:00:00Z', stars: 1 });
  });

  it('aligns buckets to UTC days and counts only in-range events in edge buckets', async () => {
    const get = await api([star('2026-08-02T06:00:00Z'), star('2026-08-02T18:00:00Z'), star('2026-08-03T18:00:00Z')]);
    const body = await get('/api/repos/acme/widget/activity?from=2026-08-02T12:00:00Z&to=2026-08-03T12:00:00Z&bucket=day');
    expect(body.buckets.map((b: any) => [b.start, b.stars])).toEqual([
      ['2026-08-02T00:00:00Z', 1], ['2026-08-03T00:00:00Z', 0],
    ]);
  });

  it('plots PRs by reconstructed lifecycle time and ignores label noise', async () => {
    const get = await api([
      prEvent('opened', 1, '2026-08-02T10:00:00Z'),
      prEvent('labeled', 1, '2026-08-02T11:00:00Z'),
      prEvent('merged', 1, '2026-08-03T10:00:00Z'),
      prComment(2, '2026-08-04T00:00:00Z', { state: 'open', created_at: '2026-08-02T09:00:00Z' }),
      line('IssuesEvent', '2026-08-02T12:00:00Z', { action: 'labeled', issue: { number: 5 } }),
    ]);
    const body = await get('/api/repos/acme/widget/activity?from=2026-08-02&to=2026-08-04&bucket=day');
    expect(body.buckets.map((b: any) => [b.prs_opened, b.prs_merged, b.issues])).toEqual([[2, 0, 0], [0, 1, 0]]);
  });
});

describe('pull request endpoints', () => {
  const prs = [
    prEvent('opened', 1, '2026-08-02T00:00:00Z', { actor: 'bob' }),
    prEvent('merged', 1, '2026-08-02T02:00:00Z'),                       // 2h
    prComment(2, '2026-08-06T00:00:00Z', {                               // created before coverage
      state: 'closed', created_at: '2026-07-20T00:00:00Z', merged_at: '2026-08-05T00:00:00Z',
    }),
    prEvent('opened', 3, '2026-08-03T00:00:00Z'),
    prEvent('closed', 3, '2026-08-04T00:00:00Z'),
    prEvent('reopened', 3, '2026-08-05T00:00:00Z'),                     // open again
    prEvent('opened', 4, '2026-08-03T00:00:00Z'),
    prEvent('closed', 4, '2026-08-04T00:00:00Z'),                        // closed unmerged
    review(5, '2026-08-04T00:00:00Z'),                                   // state unknown
    prEvent('merged', 6, '2026-08-04T00:00:00Z'),                        // created unknown
    prComment(7, '2026-08-09T00:00:00Z', {                               // inconsistent payload
      state: 'closed', created_at: '2026-08-09T00:00:00Z', merged_at: '2026-08-08T00:00:00Z',
    }),
    prComment(8, '2026-08-08T00:00:00Z', { state: 'open', created_at: '2026-08-07T00:00:00Z', title: 'Fix', user: 'dana' }),
  ];

  it('lists PRs whose latest observation is open, as of the last event', async () => {
    const get = await api(prs);
    const body = await get('/api/repos/acme/widget/pulls/open');
    expect(body.as_of).toBe('2026-08-10T23:00:00Z');
    expect(body.state_counts).toEqual({ open: 2, merged: 4, closed: 1, unknown: 1 });
    expect(body.items.map((x: any) => x.number)).toEqual([8, 3]); // most recently seen first
    expect(body.items[0]).toMatchObject({
      title: 'Fix', author: 'dana', created_at: '2026-08-07T00:00:00Z',
      state_observed_at: '2026-08-08T00:00:00Z', last_seen_at: '2026-08-08T00:00:00Z', days_since_last_seen: 3,
    });
    expect((await get('/api/repos/acme/widget/pulls/open?limit=1&offset=1')).items.map((x: any) => x.number)).toEqual([3]);
  });

  it('computes merge durations only from valid creation and merge times', async () => {
    const get = await api(prs);
    const body = await get('/api/repos/acme/widget/pulls/merged');
    expect(body.merged).toBe(4);
    expect(body.duration).toMatchObject({
      n: 2, excluded_unknown_created_at: 1, excluded_invalid: 1,
      min: 7200, max: 16 * 86400, median: (7200 + 16 * 86400) / 2,
    });
    expect(body.duration.histogram.find((h: any) => h.label === '1-6h').count).toBe(1);
    expect(body.duration.histogram.find((h: any) => h.label === '7-30d').count).toBe(1);
    expect(body.items.find((x: any) => x.number === 6).duration_seconds).toBeNull();
  });

  it('filters merged PRs by merge time with a half-open range', async () => {
    const get = await api(prs);
    const body = await get('/api/repos/acme/widget/pulls/merged?from=2026-08-02T02:00:00Z&to=2026-08-04T00:00:00Z');
    expect(body.items.map((x: any) => x.number)).toEqual([1]);
  });

  it('handles a repository with no PR activity', async () => {
    const get = await api([star('2026-08-05T00:00:00Z', C), push('2026-08-05T00:00:00Z', 'bob', C)]);
    expect(await get('/api/repos/zeta/quiet/pulls/open')).toMatchObject({
      total: 0, items: [], state_counts: { open: 0, merged: 0, closed: 0, unknown: 0 },
    });
    expect((await get('/api/repos/zeta/quiet/pulls/merged')).duration).toMatchObject({
      n: 0, min: null, median: null, p90: null, max: null,
    });
    const act = await get('/api/repos/zeta/quiet/activity');
    expect(act.buckets.reduce((s: number, b: any) => s + b.prs_opened + b.prs_merged, 0)).toBe(0);
    expect((await get('/api/trending')).items.find((x: any) => x.repo === 'zeta/quiet'))
      .toMatchObject({ prs_opened: 0, prs_merged: 0, contributors: 1 });
  });
});

describe('GET /api/repos/:owner/:name/contributors', () => {
  const lines = [
    push('2026-08-05T01:00:00Z', 'bob'), push('2026-08-05T02:00:00Z', 'bob'),
    prEvent('opened', 1, '2026-08-05T03:00:00Z', { actor: 'alice' }),
    review(1, '2026-08-05T04:00:00Z', { actor: 'bob' }),
    push('2026-08-05T05:00:00Z', 'renovate[bot]'), push('2026-08-05T06:00:00Z', 'renovate[bot]'),
    push('2026-08-05T07:00:00Z', 'renovate[bot]'), push('2026-08-05T08:00:00Z', 'renovate[bot]'),
    star('2026-08-05T09:00:00Z', A, 'stargazer'),
    line('CreateEvent', '2026-08-05T10:00:00Z', { ref: 'b', ref_type: 'branch' }, { repo: A, actor: 'brancher' }),
  ];

  it('ranks humans by contribution events and excludes bots by default', async () => {
    const get = await api(lines);
    const body = await get('/api/repos/acme/widget/contributors');
    expect(body).toMatchObject({ include_bots: false, total: 2 });
    expect(body.items).toEqual([
      { login: 'bob', is_bot: false, total: 3, pushes: 2, pull_request_events: 0, reviews: 1, comments: 0, issue_events: 0, releases: 0 },
      { login: 'alice', is_bot: false, total: 1, pushes: 0, pull_request_events: 1, reviews: 0, comments: 0, issue_events: 0, releases: 0 },
    ]);
  });

  it('includes bots when asked', async () => {
    const get = await api(lines);
    const body = await get('/api/repos/acme/widget/contributors?include_bots=true&limit=1');
    expect(body.total).toBe(3);
    expect(body.items).toEqual([expect.objectContaining({ login: 'renovate[bot]', is_bot: true, total: 4 })]);
  });

  it('returns an empty list for a range with no activity', async () => {
    const get = await api(lines);
    expect(await get('/api/repos/acme/widget/contributors?from=2026-08-07&to=2026-08-08'))
      .toMatchObject({ total: 0, items: [] });
  });
});

describe('GET /api/repos (search)', () => {
  it('matches substrings case-insensitively, exact match first, then by activity', async () => {
    const get = await api([
      star('2026-08-05T00:00:00Z', A), push('2026-08-05T00:00:00Z', 'x', B), push('2026-08-05T01:00:00Z', 'x', B),
      star('2026-08-05T00:00:00Z', { id: 4, name: 'acme/widget-docs' }),
    ]);
    expect((await get('/api/repos?q=WIDGET')).items.map((x: any) => x.repo)).toEqual(['acme/widget', 'acme/widget-docs']);
    expect((await get('/api/repos?q=acme/widget')).items[0]).toEqual({ repo: 'acme/widget', events: 1 });
    expect((await get('/api/repos?q=o')).items[0].repo).toBe('filler/anchor'); // 3 events, the most
    expect((await get('/api/repos?q=%25')).items).toEqual([]); // % is literal, not a wildcard
    expect((await get('/api/repos?q=', 400)).error.code).toBe('invalid_parameter');
  });
});

describe('activity totals', () => {
  it('reports per-series totals equal to the bucket sums', async () => {
    const get = await api([star('2026-08-03T10:00:00Z'), star('2026-08-04T10:00:00Z'), push('2026-08-03T11:00:00Z', 'bob')]);
    const body = await get('/api/repos/acme/widget/activity?from=2026-08-01&to=2026-08-05');
    expect(body.totals).toEqual({ stars: 2, forks: 0, prs_opened: 0, prs_merged: 0, issues: 0, reviews: 0, comments: 0, pushes: 1 });
  });
});

describe('GET /api/meta', () => {
  it('reports coverage, totals and the last ingest run', async () => {
    const get = await api([star('2026-08-05T00:00:00Z')]);
    const body = await get('/api/meta');
    expect(body.coverage).toEqual({
      start: '2026-08-01T00:00:00Z', end: '2026-08-11T00:00:00Z',
      first_event_at: '2026-08-01T00:00:01Z', last_event_at: '2026-08-10T23:00:00Z',
    });
    expect(body.totals).toEqual({ events: 3, repos: 2, pull_requests: 0 });
    expect(body.last_ingest.stats.inserted).toBe(3);
  });
});
