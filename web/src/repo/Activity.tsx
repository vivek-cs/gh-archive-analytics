import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type XAxisTickContentProps } from 'recharts';
import { SERIES, type Activity, type ApiState, type Series } from '../api';
import { fmtDay, fmtHour, num } from '../format';
import { Async, Card, Empty, Info } from '../ui';
import { AXIS_TICK, ChartTip, TOOLTIP_PROPS } from './chart';

const SERIES_INFO: Record<Series, { label: string; unit: string; info: string }> = {
  stars: { label: 'Stars', unit: 'stars', info: 'Star (WatchEvent) events.' },
  forks: { label: 'Forks', unit: 'forks', info: 'Fork events.' },
  prs_opened: { label: 'PRs opened', unit: 'PRs opened', info: 'PRs by creation time, including ones seen only through comments.' },
  prs_merged: { label: 'PRs merged', unit: 'PRs merged', info: 'PRs by merge time.' },
  issues: { label: 'Issues', unit: 'issue events', info: 'Issues opened, closed or reopened.' },
  reviews: { label: 'Reviews', unit: 'reviews', info: 'PR reviews and review comments.' },
  comments: { label: 'Comments', unit: 'comments', info: 'Comments on issues, PRs and commits.' },
  pushes: { label: 'Pushes', unit: 'pushes', info: 'Push events; the data has no per-push commit counts.' },
};

// One small chart per active series (each on its own scale). Series with no activity in
// the whole range are listed compactly with their zero total instead of an empty chart.
export function ActivitySection({ state }: { state: ApiState<Activity> }) {
  return (
    <Card
      title="Activity over time"
      aside={state.data && (
        <p className="card-note">{state.data.bucket === 'hour' ? 'Hourly' : 'Daily'} UTC buckets · each chart has its own scale</p>
      )}
    >
      <Async state={state}>
        {(d) => {
          const active = SERIES.filter((s) => d.totals[s] > 0);
          const inactive = SERIES.filter((s) => d.totals[s] === 0);
          if (active.length === 0) return <Empty>No activity in this range.</Empty>;
          return (
            <>
              <div className="multiples">
                {active.map((s) => <SeriesChart key={s} data={d} series={s} />)}
              </div>
              {inactive.length > 0 && (
                <p className="inactive">
                  <span className="muted">No activity in this range:</span>
                  {inactive.map((s) => (
                    <span key={s} className="inactive-item">{SERIES_INFO[s].label} <strong>0</strong></span>
                  ))}
                </p>
              )}
            </>
          );
        }}
      </Async>
    </Card>
  );
}

function SeriesChart({ data, series }: { data: Activity; series: Series }) {
  const { label, unit, info } = SERIES_INFO[series];
  const max = Math.max(...data.buckets.map((b) => b[series]));
  const hourly = data.bucket === 'hour';
  const fmtTick = hourly ? (iso: string) => `${fmtDay(iso)} ${fmtHour(iso)}` : fmtDay;
  const first = data.buckets[0]?.start;
  const last = data.buckets.at(-1)?.start;
  return (
    <figure className="multiple">
      <figcaption>
        <span className="multiple-label">{label}<Info text={info} /></span>
        <span className="multiple-total">{num(data.totals[series])}</span>
      </figcaption>
      <div className="multiple-plot">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="12%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="start"
              ticks={first && last && first !== last ? [first, last] : first ? [first] : []}
              interval={0}
              // Only the first and last bucket are labelled; anchor them inward so they never clip.
              tick={(p: XAxisTickContentProps) => (
                <text x={p.x} y={Number(p.y) + 12} textAnchor={p.index === 0 ? 'start' : 'end'} {...AXIS_TICK}>
                  {fmtTick(p.payload.value)}
                </text>
              )}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
              height={20}
            />
            <YAxis domain={[0, max]} ticks={[0, max]} allowDecimals={false} tickFormatter={(v: number) => num(v)}
              tick={AXIS_TICK} tickLine={false} axisLine={false} width={34} />
            <Tooltip
              {...TOOLTIP_PROPS}
              content={({ active, payload }) => {
                const b = payload?.[0]?.payload as Activity['buckets'][number] | undefined;
                if (!active || !b) return null;
                return <ChartTip value={num(b[series])} label={`${unit} · ${hourly ? `${fmtDay(b.start)} ${fmtHour(b.start)} UTC` : fmtDay(b.start)}`} />;
              }}
            />
            <Bar dataKey={series} fill="var(--series-1)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
