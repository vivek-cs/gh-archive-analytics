import express, { type NextFunction, type Request, type Response } from 'express';
import { createAnalytics } from './analytics.js';
import type { DB } from './db.js';
import { ApiError, parseBool, parseBucket, parseLimit, parseRange } from './range.js';

// Read-only JSON API. Every error has the shape { error: { code, message } }.
export function createApp(db: DB) {
  const a = createAnalytics(db);
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple'); // no nested objects/arrays from query strings

  const q = (req: Request) => req.query as Record<string, unknown>;
  const repoOf = (req: Request) => a.repo(`${req.params.owner}/${req.params.name}`);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/meta', (_req, res) => {
    res.json(a.meta());
  });

  app.get('/api/trending', (req, res) => {
    const range = parseRange(q(req), a.requireCoverage());
    res.json(a.trending(range, parseLimit(q(req).limit, 25, 100)));
  });

  app.get('/api/repos/:owner/:name/activity', (req, res) => {
    const rp = repoOf(req);
    const range = parseRange(q(req), a.requireCoverage());
    res.json(a.activity(rp, range, parseBucket(q(req).bucket, range)));
  });

  app.get('/api/repos/:owner/:name/pulls/open', (req, res) => {
    const rp = repoOf(req);
    res.json(a.openPullRequests(rp, parseLimit(q(req).limit, 50, 500), parseLimit(q(req).offset, 0, 1_000_000, 'offset')));
  });

  app.get('/api/repos/:owner/:name/pulls/merged', (req, res) => {
    const rp = repoOf(req);
    const range = parseRange(q(req), a.requireCoverage());
    res.json(a.mergedPullRequests(rp, range, parseLimit(q(req).limit, 50, 500)));
  });

  app.get('/api/repos/:owner/:name/contributors', (req, res) => {
    const rp = repoOf(req);
    const range = parseRange(q(req), a.requireCoverage());
    res.json(a.contributors(rp, range, parseLimit(q(req).limit, 10, 100), parseBool(q(req).include_bots, 'include_bots')));
  });

  app.use('/api', (_req, _res, next) => {
    next(new ApiError(404, 'not_found', 'no such endpoint'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'internal server error' } });
  });

  return app;
}
