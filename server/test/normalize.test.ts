import { describe, expect, it } from 'vitest';
import { normalizeLine } from '../src/normalize.js';
import { line, prComment, prEvent, review, ts } from './helpers.js';

const reject = (l: string) => {
  const r = normalizeLine(l);
  return r.ok ? null : r.reason;
};

describe('normalizeLine: missing or invalid fields', () => {
  const good = JSON.parse(line('WatchEvent', '2026-08-01T00:00:00Z', { action: 'started' }));

  it.each([
    ['invalid_json', '{"id": "1", '],
    ['not_an_object', '[1,2]'],
    ['invalid_id', JSON.stringify({ ...good, id: undefined })],
    ['invalid_id', JSON.stringify({ ...good, id: 'abc' })],
    ['missing_type', JSON.stringify({ ...good, type: '' })],
    ['missing_repo', JSON.stringify({ ...good, repo: undefined })],
    ['missing_repo', JSON.stringify({ ...good, repo: { name: 'a/b' } })],
    ['invalid_created_at', JSON.stringify({ ...good, created_at: undefined })],
    ['invalid_created_at', JSON.stringify({ ...good, created_at: '2026-08-01 00:00:00' })],
  ])('rejects %s', (reason, l) => {
    expect(reject(l)).toBe(reason);
  });

  it('accepts events with no actor or payload', () => {
    const r = normalizeLine(JSON.stringify({ ...good, actor: undefined, payload: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({ actorLogin: null, actorId: null, isBot: false, action: null });
    expect(r.pr).toBeNull();
  });

  it('keeps a PR event whose payload has no number, without a PR observation', () => {
    const r = normalizeLine(line('PullRequestEvent', '2026-08-01T00:00:00Z', { action: 'opened' }));
    expect(r.ok && r.event.category === 'pr' && r.pr === null).toBe(true);
  });
});

describe('normalizeLine: fields', () => {
  it('maps category, bot flag and timestamp', () => {
    const r = normalizeLine(line('PushEvent', '2026-08-02T03:04:05Z', {}, { actor: 'github-actions[bot]' }));
    expect(r.ok && r.event).toMatchObject({
      category: 'push', isBot: true, createdAt: ts('2026-08-02T03:04:05Z'), repoName: 'acme/widget',
    });
  });

  it('treats an opened event as the creation time and author', () => {
    const r = normalizeLine(prEvent('opened', 7, '2026-08-01T10:00:00Z', { actor: 'bob' }));
    expect(r.ok && r.pr).toMatchObject({
      number: 7, state: 'open', createdAt: ts('2026-08-01T10:00:00Z'), author: 'bob', source: 'pr_event',
    });
  });

  it('does not attribute a label action to the PR author or state', () => {
    const r = normalizeLine(prEvent('labeled', 7, '2026-08-01T10:00:00Z', { actor: 'triager' }));
    expect(r.ok && r.pr).toMatchObject({ state: null, author: null, createdAt: null });
  });

  it('takes lifecycle times from the issue payload, not the comment time', () => {
    const r = normalizeLine(prComment(9, '2026-08-20T00:00:00Z', {
      state: 'closed', created_at: '2026-07-01T00:00:00Z',
      closed_at: '2026-08-05T00:00:00Z', merged_at: '2026-08-05T00:00:00Z', user: 'carol',
    }));
    expect(r.ok && r.pr).toMatchObject({
      observedAt: ts('2026-08-20T00:00:00Z'),
      state: 'merged',
      createdAt: ts('2026-07-01T00:00:00Z'),
      mergedAt: ts('2026-08-05T00:00:00Z'),
      author: 'carol',
    });
  });

  it('ignores comments on plain issues', () => {
    const l = line('IssueCommentEvent', '2026-08-01T00:00:00Z', {
      action: 'created', issue: { number: 3, state: 'open', created_at: '2026-08-01T00:00:00Z' },
    });
    const r = normalizeLine(l);
    expect(r.ok && r.pr).toBeNull();
  });

  it('records review events as observations with no state', () => {
    const r = normalizeLine(review(4, '2026-08-01T00:00:00Z'));
    expect(r.ok && r.pr).toMatchObject({ number: 4, state: null, source: 'review_event' });
  });
});
