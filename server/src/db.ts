import Database from 'better-sqlite3';

export type DB = Database.Database;

// Timestamps are stored as INTEGER unix seconds (UTC).
// events          one row per unique GitHub event id; only the columns the analytics need.
// pr_observations one row per event that references a pull request: what that event told us
//                 about the PR. Kept so pull_requests can be rebuilt deterministically.
// pull_requests   derived from pr_observations by rebuildPullRequests(); never written directly.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  name_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS repos_name ON repos(name);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  action      TEXT,
  category    TEXT NOT NULL,
  actor_id    INTEGER,
  actor_login TEXT,
  is_bot      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  pr_number   INTEGER
);
CREATE INDEX IF NOT EXISTS events_repo_time ON events(repo_id, created_at);
CREATE INDEX IF NOT EXISTS events_category_time ON events(category, created_at, repo_id);

CREATE TABLE IF NOT EXISTS pr_observations (
  event_id    INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL,
  number      INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  source      TEXT NOT NULL,
  state       TEXT,
  created_at  INTEGER,
  closed_at   INTEGER,
  merged_at   INTEGER,
  author      TEXT,
  title       TEXT
);
CREATE INDEX IF NOT EXISTS pr_obs_pr ON pr_observations(repo_id, number, observed_at, event_id);

CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id           INTEGER NOT NULL,
  number            INTEGER NOT NULL,
  state             TEXT,
  state_observed_at INTEGER,
  created_at        INTEGER,
  closed_at         INTEGER,
  merged_at         INTEGER,
  author            TEXT,
  title             TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  observations      INTEGER NOT NULL,
  PRIMARY KEY (repo_id, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS prs_repo_state ON pull_requests(repo_id, state);
CREATE INDEX IF NOT EXISTS prs_repo_merged ON pull_requests(repo_id, merged_at);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  stats       TEXT NOT NULL
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
