"""Cross-checks API responses against SQL written independently of server/src/analytics.ts.

Start the API first (npm run serve), then:
  python3 scripts/crosscheck_api.py [http://localhost:3001] [data/gh.sqlite]
"""
import json
import math
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone

base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3001'
db = sqlite3.connect(sys.argv[2] if len(sys.argv) > 2 else 'data/gh.sqlite')
CONTRIB = "('pr','push','review','comment','issue','release')"
results = []


def get(path):
    with urllib.request.urlopen(base + path) as r:
        return json.load(r)


def ts(s):
    return int(datetime.strptime(s, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())


def check(name, expected, actual):
    ok = expected == actual
    results.append(ok)
    print(f"  [{'OK ' if ok else 'MISMATCH'}] {name}" + ('' if ok else f'\n      sql={expected!r}\n      api={actual!r}'))


def rows(sql, *args):
    return db.execute(sql, args).fetchall()


def quantile(xs, q):  # numpy-style linear interpolation
    xs = sorted(xs)
    pos = (len(xs) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo))


# 1. Trending, full month: ranking and totals
api = get('/api/trending?limit=100')
sql = rows("""SELECT r.name, COUNT(*) c FROM events e JOIN repos r ON r.id = e.repo_id
              WHERE e.type = 'WatchEvent' GROUP BY r.name ORDER BY c DESC, r.name LIMIT 100""")
check('trending (month): top 100 repo/stars order', sql, [(x['repo'], x['stars']) for x in api['items']])
check('trending (month): repos with >=1 star', rows("SELECT COUNT(DISTINCT repo_id) FROM events WHERE type='WatchEvent'")[0][0], api['total'])
check('trending (month): comparison unavailable', False, api['comparison']['available'])

# 2. Trending, last 7 days: every supporting metric and growth
f, t = ts('2026-08-25'), ts('2026-09-01')
pf = f - (t - f)
api = get('/api/trending?from=2026-08-25&to=2026-09-01&limit=15')
check('trending (7d): comparison available', True, api['comparison']['available'])
for item in api['items']:
    rid = rows('SELECT id FROM repos WHERE name = ?', item['repo'])[0][0]
    q = lambda sql, *a: rows(sql, rid, *a)[0][0]
    stars = q("SELECT COUNT(*) FROM events WHERE repo_id=? AND type='WatchEvent' AND created_at>=? AND created_at<?", f, t)
    prev = q("SELECT COUNT(*) FROM events WHERE repo_id=? AND type='WatchEvent' AND created_at>=? AND created_at<?", pf, f)
    expected = {
        'stars': stars,
        'forks': q("SELECT COUNT(*) FROM events WHERE repo_id=? AND type='ForkEvent' AND created_at>=? AND created_at<?", f, t),
        'prs_opened': q('SELECT COUNT(*) FROM pull_requests WHERE repo_id=? AND created_at>=? AND created_at<?', f, t),
        'prs_merged': q('SELECT COUNT(*) FROM pull_requests WHERE repo_id=? AND merged_at>=? AND merged_at<?', f, t),
        'contributors': q(f"""SELECT COUNT(DISTINCT actor_login) FROM events WHERE repo_id=? AND created_at>=? AND created_at<?
                              AND category IN {CONTRIB} AND actor_login NOT LIKE '%[bot]'""", f, t),
        'previous_stars': prev,
        'stars_change': stars - prev,
        'growth_pct': None if prev == 0 else math.floor((stars - prev) / prev * 1000 + 0.5) / 10,  # half-up, like JS Math.round
    }
    check(f"trending (7d): {item['repo']}", expected, {k: item[k] for k in expected})

# 3. Activity: daily buckets for the busiest repo, bucketed with SQLite date functions instead
api = get('/api/repos/PostHog/posthog/activity')
check('activity: 31 daily buckets', 31, len(api['buckets']))
by_day = dict(rows("""SELECT date(created_at, 'unixepoch'), COUNT(*) FROM events e JOIN repos r ON r.id=e.repo_id
                      WHERE r.name='PostHog/posthog' AND type='PushEvent' GROUP BY 1"""))
check('activity: pushes per day', [by_day.get(b['start'][:10], 0) for b in api['buckets']], [b['pushes'] for b in api['buckets']])
for series, cond in [('stars', "type='WatchEvent'"), ('reviews', "type IN ('PullRequestReviewEvent','PullRequestReviewCommentEvent')"),
                     ('issues', "type='IssuesEvent' AND action IN ('opened','closed','reopened')")]:
    total = rows(f"SELECT COUNT(*) FROM events e JOIN repos r ON r.id=e.repo_id WHERE r.name='PostHog/posthog' AND {cond}")[0][0]
    check(f'activity: total {series}', total, sum(b[series] for b in api['buckets']))
total = rows("""SELECT COUNT(*) FROM pull_requests p JOIN repos r ON r.id=p.repo_id WHERE r.name='PostHog/posthog'
                AND created_at >= ? AND created_at < ?""", ts('2026-08-01'), ts('2026-09-01'))[0][0]
check('activity: total prs_opened', total, sum(b['prs_opened'] for b in api['buckets']))
api = get('/api/repos/PostHog/posthog/activity?from=2026-08-29&to=2026-09-01')
check('activity (72h): hourly with 72 buckets', ('hour', 72), (api['bucket'], len(api['buckets'])))

# 4. Open PRs
api = get('/api/repos/openclaw/openclaw/pulls/open?limit=20')
sql = rows("""SELECT number FROM pull_requests p JOIN repos r ON r.id=p.repo_id WHERE r.name='openclaw/openclaw'
              AND state='open' ORDER BY last_seen_at DESC, number DESC LIMIT 20""")
check('open PRs: first page', [x[0] for x in sql], [x['number'] for x in api['items']])
counts = dict(rows("""SELECT IFNULL(state,'unknown'), COUNT(*) FROM pull_requests p JOIN repos r ON r.id=p.repo_id
                      WHERE r.name='openclaw/openclaw' GROUP BY 1"""))
check('open PRs: state counts', {k: counts.get(k, 0) for k in ('open', 'merged', 'closed', 'unknown')}, api['state_counts'])

# 5. Merge durations
for repo in ['openclaw/openclaw', 'PostHog/posthog', 'pytorch/pytorch']:
    api = get(f'/api/repos/{repo}/pulls/merged')
    d = [x[0] for x in rows("""SELECT merged_at - created_at FROM pull_requests p JOIN repos r ON r.id=p.repo_id
                               WHERE r.name=? AND merged_at IS NOT NULL AND created_at IS NOT NULL AND merged_at >= created_at""", repo)]
    exp = {'n': len(d), 'median': quantile(d, .5) if d else None, 'p90': quantile(d, .9) if d else None,
           'min': min(d) if d else None, 'max': max(d) if d else None}
    check(f'merge durations: {repo}', exp, {k: api['duration'][k] for k in exp})

# 6. Contributors
for bots in ['false', 'true']:
    api = get(f'/api/repos/PostHog/posthog/contributors?include_bots={bots}&limit=10')
    bot_filter = '' if bots == 'true' else "AND actor_login NOT LIKE '%[bot]'"
    sql = rows(f"""SELECT actor_login, COUNT(*) c FROM events e JOIN repos r ON r.id=e.repo_id
                   WHERE r.name='PostHog/posthog' AND category IN {CONTRIB} AND actor_login IS NOT NULL {bot_filter}
                   GROUP BY actor_login ORDER BY c DESC, actor_login LIMIT 10""")
    check(f'contributors (bots={bots}): top 10', sql, [(x['login'], x['total']) for x in api['items']])

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
