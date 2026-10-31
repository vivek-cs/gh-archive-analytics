import type { ReactNode } from 'react';

// Shared Recharts styling: recessive axes and grid, and one compact tooltip style.

export const AXIS_TICK = { fill: 'var(--muted)', fontSize: 11 } as const;

// Spread onto <Tooltip>: may rise above the plot (small charts are short) but never
// past its sides, sits above neighbouring charts, and doesn't animate.
export const TOOLTIP_PROPS = {
  allowEscapeViewBox: { x: false, y: true },
  wrapperStyle: { zIndex: 5, outline: 'none', pointerEvents: 'none' as const },
  offset: 10,
  isAnimationActive: false,
  cursor: { fill: 'var(--hover)' },
};

export function ChartTip({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <div className="chart-tip">
      <strong>{value}</strong>
      <span className="muted">{label}</span>
    </div>
  );
}
