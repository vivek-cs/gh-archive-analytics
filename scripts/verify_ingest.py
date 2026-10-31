"""Independent check of the SQLite database against the raw JSONL file.

Re-derives every count (and every pull request row) in plain Python, straight from
the source file, and compares with what the TypeScript ingest stored.

Usage: python3 scripts/verify_ingest.py [events.jsonl] [data/gh.sqlite]
"""
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

src = sys.argv[1] if len(sys.argv) > 1 else 'events.jsonl'
dbp = sys.argv[2] if len(sys.argv) > 2 else 'data/gh.sqlite'


def t(s):
    if not s:
        return None
    return int(datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp())


seen = set()
lines = dups = 0
by_type, by_repo, bots, stars = Counter(), Counter(), Counter(), Counter()
star_actors = defaultdict(set)
repo_names = {}
obs = defaultdict(list)  # (repo_id, number) -> [(ts, event_id, state, created, closed, merged, author, title)]
min_ts = max_ts = None

for line in open(src, encoding='utf-8'):
    lines += 1
    e = json.loads(line)
    if e['id'] in seen:
        dups += 1
        continue
    seen.add(e['id'])
    ts, eid, ty, p = t(e['created_at']), int(e['id']), e['type'], e.get('payload') or {}
    rid, login = e['repo']['id'], (e.get('actor') or {}).get('login')
    min_ts = ts if min_ts is None else min(min_ts, ts)
    max_ts = ts if max_ts is None else max(max_ts, ts)
    by_type[ty] += 1
    by_repo[rid] += 1
    repo_names[rid] = e['repo']['name']
    if login and login.endswith('[bot]'):
        bots[ty] += 1
    if ty == 'WatchEvent':
        stars[rid] += 1
        star_actors[rid].add(login)
    a = p.get('action')
    if ty == 'PullRequestEvent':
        state = {'opened': 'open', 'reopened': 'open', 'merged': 'merged', 'closed': 'closed'}.get(a)
        obs[(rid, p['number'])].append((ts, eid, state,
                                        ts if a == 'opened' else None,
                                        ts if a in ('merged', 'closed') else None,
                                        ts if a == 'merged' else None,
                                        login if a == 'opened' else None, None))
    elif ty in ('PullRequestReviewEvent', 'PullRequestReviewCommentEvent'):
        obs[(rid, p['pull_request']['number'])].append((ts, eid, None, None, None, None, None, None))
    elif ty in ('IssueCommentEvent', 'IssuesEvent') and 'pull_request' in p['issue']:
        i = p['issue']
        m = t(i['pull_request'].get('merged_at'))
        obs[(rid, i['number'])].append((ts, eid, 'merged' if m else i['state'], t(i['created_at']),
                                        t(i.get('closed_at')), m, i['user']['login'], i['title']))

expected_prs = {}
for key, rows in obs.items():
    rows.sort(key=lambda r: (r[0], r[1]))
    state = state_at = None
    created = merged = last_closed = author = title = None
    for ts, _, st, c, cl, m, au, ti in rows:
        if st:
            state, state_at = st, ts
        if c is not None:
            created = c if created is None else min(created, c)
        if m is not None:
            merged = m if merged is None else min(merged, m)
        if cl is not None:
            last_closed = cl if last_closed is None else max(last_closed, cl)
        author = author or au
        title = ti or title
    if merged is not None:
        state = 'merged'
    closed = (last_closed if last_closed is not None else merged) if state == 'merged' else \
        last_closed if state == 'closed' else None
    expected_prs[key] = (state, state_at, created, closed, merged, author, title,
                         rows[0][0], rows[-1][0], len(rows))

db = sqlite3.connect(dbp)
q = lambda sql: db.execute(sql).fetchall()
checks = []


def check(name, expected, actual):
    checks.append((name, expected == actual))
    status = 'OK ' if expected == actual else 'MISMATCH'
    detail = '' if expected == actual else f'\n      expected={expected!r}\n      actual  ={actual!r}'
    print(f'  [{status}] {name}{detail}')


print(f'source: {lines} lines, {len(seen)} unique ids, {dups} duplicate lines')
check('event rows', len(seen), q('SELECT COUNT(*) FROM events')[0][0])
check('events by type', dict(by_type), dict(q('SELECT type, COUNT(*) FROM events GROUP BY type')))
check('events by repo', dict(by_repo), dict(q('SELECT repo_id, COUNT(*) FROM events GROUP BY repo_id')))
check('bot events by type', dict(bots), dict(q('SELECT type, COUNT(*) FROM events WHERE is_bot GROUP BY type')))
check('star events by repo', dict(stars),
      dict(q("SELECT repo_id, COUNT(*) FROM events WHERE category = 'star' GROUP BY repo_id")))
check('distinct starring actors by repo', {k: len(v) for k, v in star_actors.items()},
      dict(q("SELECT repo_id, COUNT(DISTINCT actor_login) FROM events WHERE category='star' GROUP BY repo_id")))
check('repos', repo_names, dict(q('SELECT id, name FROM repos')))
check('time range', (min_ts, max_ts), q('SELECT MIN(created_at), MAX(created_at) FROM events')[0])
check('pr_observations rows', sum(len(v) for v in obs.values()), q('SELECT COUNT(*) FROM pr_observations')[0][0])
actual_prs = {(r[0], r[1]): tuple(r[2:]) for r in q(
    'SELECT repo_id, number, state, state_observed_at, created_at, closed_at, merged_at, author, title, '
    'first_seen_at, last_seen_at, observations FROM pull_requests')}
check('pull_requests row count', len(expected_prs), len(actual_prs))
bad = [k for k in expected_prs if expected_prs[k] != actual_prs.get(k)]
check('pull_requests rows identical (all columns)', [], bad[:5])
check('PR state counts', dict(Counter(v[0] for v in expected_prs.values())),
      dict(q('SELECT state, COUNT(*) FROM pull_requests GROUP BY state')))

failed = [n for n, ok in checks if not ok]
print(f'\n{len(checks) - len(failed)}/{len(checks)} checks passed')
sys.exit(1 if failed else 0)
