// Browser smoke test against a running app and the real database.
//
//   npm run build && npm start        # in one terminal (serves http://localhost:3001)
//   npm run smoke [-- <baseUrl>] [--shots <dir>]
//
// Uses the locally installed Chrome (set CHROME_PATH to override). Exits non-zero on failure.
import { existsSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt >= 0 ? args[shotsAt + 1] : null;
const shotsValueAt = shotsAt >= 0 ? shotsAt + 1 : -1;
const BASE = args.find((a, i) => !a.startsWith('--') && i !== shotsValueAt) ?? 'http://localhost:3001';
const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('Chrome not found; set CHROME_PATH');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));

const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const texts = (sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
// Text of an element without its info-icon buttons.
const labels = (sel) => page.$$eval(sel, (es) => es.map((e) =>
  [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()));
const settle = () => page.waitForNetworkIdle({ idleTime: 100 });
const go = async (path, sel) => {
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForSelector(sel);
  await settle();
};
const clickButton = async (scope, label) => {
  await page.evaluate((s, l) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim() === l).click(), scope, label);
  await settle();
};
const buttonDisabled = (scope, label) =>
  page.evaluate((s, l) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim() === l)?.disabled, scope, label);
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const num = (s) => Number(s.replace(/,/g, ''));
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

// Tooltip of an Info button: opens, has text, and lies fully inside the viewport.
async function tooltipCheck(name, btnHandle, how) {
  if (how === 'tap') await btnHandle.tap(); else await btnHandle.hover();
  const tip = await page.waitForSelector('.info-tip', { visible: true, timeout: 2000 }).catch(() => null);
  if (!tip) return check(`${name}: tooltip opens on ${how}`, false, 'no tooltip');
  const r = await page.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight, text: el.textContent };
  }, tip);
  check(`${name}: tooltip opens on ${how} and fits the viewport`,
    r.left >= 0 && r.right <= r.w && r.top >= 0 && r.bottom <= r.h && r.text.length > 0, JSON.stringify(r));
  if (how === 'tap') await page.touchscreen.tap(5, 5); else await page.mouse.move(5, 5);
  await page.waitForSelector('.info-tip', { hidden: true, timeout: 2000 }).then(() => check(`${name}: tooltip closes`, true))
    .catch(() => check(`${name}: tooltip closes`, false));
}

// ---------- Trending (desktop) ----------
await page.setViewport({ width: 1440, height: 900 });
await go('/?range=7d', 'table.trending tbody tr');
const t1 = await api('/api/trending?from=2026-08-25T00:00:00Z&to=2026-09-01T00:00:00Z&limit=25&offset=0');
check('trending: description names the momentum score', (await text('.card-note')).startsWith('Ranked by momentum score'));
eq('trending: column headers', await labels('table.trending th'),
  ['#', 'Repository', 'Score', 'Stars', 'Star growth', 'Forks', 'PRs opened', 'Issues opened', 'Contributors']);
const rows = await page.$$eval('table.trending tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim())));
eq('trending: rows and order match the API', rows.map((r) => [num(r[0]), r[1]]), t1.items.map((x) => [x.rank, x.repo]));
const scoreOk = rows.every((r, i) => {
  const x = t1.items[i];
  const [score, stars, forks, prs, issues] = [r[2], r[3], r[5], r[6], r[7]].map(num);
  return score === x.score && stars === x.stars && forks === x.forks && prs === x.prs_opened && issues === x.issues_opened
    && score === 3 * stars + 2 * forks + prs + 0.5 * issues;
});
check('trending: every displayed score = 3·stars + 2·forks + PRs + 0.5·issues, and matches the API', scoreOk);
check('trending: star growth shown as signed change and percentage', rows.every((r, i) =>
  t1.items[i].stars_change === null || r[4].startsWith(t1.items[i].stars_change > 0 ? '+' : t1.items[i].stars_change < 0 ? '−' : '0')));
eq('trending: pager on page 1', await text('.pager .muted'), `1–25 of ${t1.total} repositories · Page 1 of ${Math.ceil(t1.total / 25)}`);
eq('trending: Previous disabled / Next enabled on page 1', [await buttonDisabled('.pager', 'Previous'), await buttonDisabled('.pager', 'Next')], [true, false]);
await tooltipCheck('trending score header', (await page.$$('table.trending th .info-btn'))[0], 'hover');
await tooltipCheck('trending contributors header (right edge)', (await page.$$('table.trending th .info-btn')).at(-1), 'hover');
await shot('desktop-trending');

await clickButton('.pager', 'Next');
eq('trending: Next goes to page 2 in the URL', new URL(page.url()).search, '?range=7d&page=2');
eq('trending: page 2 starts at rank 26', (await texts('table.trending tbody tr td:first-child'))[0], '26');
eq('trending: Previous enabled on page 2', await buttonDisabled('.pager', 'Previous'), false);

const lastPage = Math.ceil(t1.total / 25);
await go(`/?range=7d&page=${lastPage}`, '.pager');
eq('trending: last page row count', (await texts('table.trending tbody tr')).length, t1.total - (lastPage - 1) * 25);
eq('trending: Next disabled on last page', await buttonDisabled('.pager', 'Next'), true);
await go('/?range=7d&page=999', '.pager');
check('trending: out-of-range page explains itself and offers Previous', (await text('.card .status')).includes('past the end')
  && (await buttonDisabled('.pager', 'Previous')) === false);
await clickButton('.pager', 'Previous');
eq('trending: Previous from out-of-range page lands on the last page', new URL(page.url()).search, `?range=7d&page=${lastPage}`);

await clickButton('.segmented', '24h');
eq('trending: changing the range resets to page 1', new URL(page.url()).search, '?range=24h');
eq('trending: first rank after range change', (await texts('table.trending tbody tr td:first-child'))[0], '1');
await clickButton('.segmented', 'All');
check('trending: All range shows N/A star growth', (await texts('table.trending tbody tr td:nth-child(5)')).every((s) => s === 'N/A'));

// ---------- Search & navigation ----------
await go('/?range=7d', 'table.trending');
await page.type('.search input', 'deepseek-harness');
await page.waitForSelector('.search-results li[role="option"]');
await page.keyboard.press('Enter');
await page.waitForSelector('.card h2');
await settle();
eq('search: Enter opens the repo with the range kept', new URL(page.url()).pathname + new URL(page.url()).search, '/repo/deepseek-ai/deepseek-harness?range=7d');

// ---------- deepseek-harness: stars/forks only ----------
const ds = await api('/api/repos/deepseek-ai/deepseek-harness/activity?from=2026-08-25T00:00:00Z&to=2026-09-01T00:00:00Z');
const activeSeries = Object.entries(ds.totals).filter(([, n]) => n > 0).length;
eq('deepseek: one chart per active series', (await page.$$('.multiple')).length, activeSeries);
eq('deepseek: inactive series listed with 0', (await page.$$('.inactive-item')).length, 8 - activeSeries);
check('deepseek: inactive list says "No activity in this range"', (await text('.inactive')).startsWith('No activity in this range'));
check('deepseek: merge card shows an empty state', (await texts('.detail-row .status')).some((s) => s.includes('No merges observed')));
await shot('desktop-deepseek');

// ---------- PostHog: varied activity, merges, contributors ----------
await go('/repo/PostHog/posthog?range=all', '.multiples svg');
const ph = await api('/api/repos/PostHog/posthog/pulls/merged?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z&limit=1');
eq('posthog: merge sample size from the API', (await text('.sample')).split(' · ')[0], `Based on ${ph.duration.n} of ${ph.merged} merged PRs`);
const phTotals = (await api('/api/repos/PostHog/posthog/activity?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z')).totals;
const shown = Object.fromEntries((await labels('.multiple-label')).map((l, i) => [l, i]));
const shownTotals = (await texts('.multiple-total')).map(num);
eq('posthog: chart totals match the API', [shownTotals[shown.Stars], shownTotals[shown.Pushes], shownTotals[shown['PRs opened']]],
  [phTotals.stars, phTotals.pushes, phTotals.prs_opened]);
const bar = await page.$('.multiple:last-child .recharts-bar-rectangle path');
const box = await bar.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 2);
const ctip = await page.waitForSelector('.chart-tip', { visible: true, timeout: 2000 }).catch(() => null);
const cbox = ctip && await ctip.boundingBox();
check('posthog: chart tooltip shows and fits the viewport', !!cbox && cbox.x >= 0 && cbox.x + cbox.width <= 1440, JSON.stringify(cbox));
const before = await text('.detail-row .table-foot');
await page.click('.toggle input');
await settle();
check('posthog: Include bots changes the contributor count', (await text('.detail-row .table-foot')) !== before, before);
check('posthog: at most 10 contributors listed', (await page.$$('table.contributors tbody tr')).length <= 10);
await shot('desktop-posthog');

// ---------- openclaw: open PR pagination ----------
await go('/repo/openclaw/openclaw?range=7d', 'table.prs tbody tr');
const oc = await api('/api/repos/openclaw/openclaw/pulls/open?limit=25&offset=0');
const prPager = '.card:last-child .pager';
eq('openclaw: open PR pager on page 1', await text(`${prPager} .muted`), `1–25 of ${oc.total} open PRs · Page 1 of ${Math.ceil(oc.total / 25)}`);
const firstPage = await texts('table.prs tbody td:first-child');
await clickButton(prPager, 'Next');
eq('openclaw: page 2 range', (await text(`${prPager} .muted`)).split(' · ')[0], `26–50 of ${oc.total} open PRs`);
check('openclaw: page 2 has different PRs', (await texts('table.prs tbody td:first-child'))[0] !== firstPage[0]);
for (let i = 0; i < 40 && !(await buttonDisabled(prPager, 'Next')); i++) await clickButton(prPager, 'Next');
eq('openclaw: last page row count', (await page.$$('table.prs tbody tr')).length, oc.total - Math.floor((oc.total - 1) / 25) * 25);
await clickButton(prPager, 'Previous');
eq('openclaw: Previous from the last page', (await text(`${prPager} .muted`)).includes(`Page ${Math.ceil(oc.total / 25) - 1} of`), true);
await go('/repo/PostHog/posthog?range=7d', 'table.prs');
eq('switching repos resets the PR page', (await text('.card:last-child .pager .muted')).split(' · ').at(-1).startsWith('Page 1 of'), true);

// ---------- Unknown repo ----------
await go('/repo/no/such-repo', '.status-error');
check('unknown repo shows a not-found message', (await text('.status-error')).includes('unknown repository'));

// ---------- Responsive layouts ----------
for (const [label, vp] of [['tablet', { width: 820, height: 1100 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  await page.setViewport(vp);
  await go('/?range=7d', 'table.trending tbody tr');
  eq(`${label}: no horizontal page scroll on trending`, await overflow(), 0);
  if (vp.hasTouch) await tooltipCheck(`${label} score header`, (await page.$$('table.trending th .info-btn'))[0], 'tap');
  await shot(`${label}-trending`);
  for (const repo of ['PostHog/posthog', 'deepseek-ai/deepseek-harness']) {
    await go(`/repo/${repo}?range=7d`, '.card h2');
    eq(`${label}: no horizontal page scroll on ${repo}`, await overflow(), 0);
    if (label === 'tablet' && repo === 'PostHog/posthog') {
      const fits = await page.$eval('table.prs', (t) => t.getBoundingClientRect().right <= t.closest('.table-wrap').getBoundingClientRect().right + 1);
      check('tablet: open PR table fits without sideways scrolling', fits);
    }
    await shot(`${label}-${repo.split('/')[1]}`);
  }
  if (vp.hasTouch) await tooltipCheck(`${label} activity label`, await page.$('.multiple .info-btn'), 'tap');
}

eq('no page errors or unexpected console errors', errors, []);
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
