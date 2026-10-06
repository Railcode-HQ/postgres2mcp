import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDuration, formatInt } from '@/lib/format'
import type { StatsPoint, StatsRange } from '@/lib/types'

// The outcome series, bottom to top. The order is part of the palette: these
// three colours were validated as neighbours in exactly this sequence.
export const OUTCOMES = [
  { key: 'ok', label: 'OK', color: 'var(--chart-ok)' },
  { key: 'denied', label: 'Denied', color: 'var(--chart-denied)' },
  { key: 'errors', label: 'Errors', color: 'var(--chart-error)' },
] as const

type OutcomeKey = (typeof OUTCOMES)[number]['key']

/** Axis label for a bucket: time of day for short windows, the date for long ones. */
export function bucketLabel(iso: string, range: StatsRange): string {
  const date = new Date(iso)
  if (range === '1h' || range === '24h') {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Tooltip title: the bucket, unambiguously. */
export function bucketTitle(iso: string, range: StatsRange): string {
  const date = new Date(iso)
  if (range === '30d') return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

const AXIS_TICK = { fill: 'var(--color-muted-foreground)', fontSize: 11 }
const RADIUS = 4
const GAP = 2

interface ShapeProps {
  x?: number
  y?: number
  width?: number
  height?: number
  fill?: string
  payload?: StatsPoint
}

// One segment of a stacked column. The topmost non-empty segment gets the
// rounded data-end; every segment above the baseline gives up 2px at its foot,
// so neighbours are separated by surface rather than by a stroke.
const segment = (key: OutcomeKey) =>
  function Segment({ x = 0, y = 0, width = 0, height = 0, fill, payload }: ShapeProps) {
    if (!payload || height <= 0) return null
    const index = OUTCOMES.findIndex((outcome) => outcome.key === key)
    const isTop = OUTCOMES.slice(index + 1).every((outcome) => payload[outcome.key] === 0)
    const isBottom = OUTCOMES.slice(0, index).every((outcome) => payload[outcome.key] === 0)
    const h = isBottom ? height : Math.max(height - GAP, 1)
    if (!isTop) return <rect x={x} y={y} width={width} height={h} fill={fill} />
    const r = Math.min(RADIUS, width / 2, h)
    return (
      <path
        fill={fill}
        d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + h} Z`}
      />
    )
  }

const SEGMENTS = Object.fromEntries(OUTCOMES.map((outcome) => [outcome.key, segment(outcome.key)])) as Record<
  OutcomeKey,
  ReturnType<typeof segment>
>

function TooltipCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      {children}
    </div>
  )
}

function CallsTip({
  active,
  payload,
  range,
}: {
  active?: boolean
  payload?: { payload: StatsPoint }[]
  range: StatsRange
}) {
  const point = active && payload?.length ? payload[0].payload : null
  if (!point) return null
  return (
    <TooltipCard title={bucketTitle(point.t, range)}>
      <div className="space-y-0.5">
        {OUTCOMES.map((outcome) => (
          <div key={outcome.key} className="flex items-center gap-2">
            {/* A short stroke keys the series; the value leads. */}
            <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: outcome.color }} />
            <span className="tabular w-10 text-right font-mono font-medium text-foreground">
              {formatInt(point[outcome.key])}
            </span>
            <span className="text-muted-foreground">{outcome.label}</span>
          </div>
        ))}
      </div>
    </TooltipCard>
  )
}

export function OutcomeLegend() {
  return (
    <div className="flex items-center gap-3">
      {OUTCOMES.map((outcome) => (
        <span key={outcome.key} className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <span className="size-2 rounded-[2px]" style={{ background: outcome.color }} />
          {outcome.label}
        </span>
      ))}
    </div>
  )
}

// Calls per bucket, stacked by how they ended.
export function CallsChart({ series, range }: { series: StatsPoint[]; range: StatsRange }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(value: string) => bucketLabel(value, range)}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          minTickGap={36}
        />
        <YAxis width={36} allowDecimals={false} tickLine={false} axisLine={false} tick={AXIS_TICK} />
        <Tooltip
          content={<CallsTip range={range} />}
          cursor={{ fill: 'var(--color-muted-foreground)', fillOpacity: 0.08 }}
          isAnimationActive={false}
        />
        {OUTCOMES.map((outcome) => (
          <Bar
            key={outcome.key}
            dataKey={outcome.key}
            stackId="calls"
            fill={outcome.color}
            maxBarSize={24}
            shape={SEGMENTS[outcome.key]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function LatencyTip({
  active,
  payload,
  range,
}: {
  active?: boolean
  payload?: { payload: StatsPoint }[]
  range: StatsRange
}) {
  const point = active && payload?.length ? payload[0].payload : null
  if (!point) return null
  const executed = point.ok + point.errors
  return (
    <TooltipCard title={bucketTitle(point.t, range)}>
      {executed === 0 ? (
        <span className="text-muted-foreground">No calls ran</span>
      ) : (
        <div className="flex items-center gap-2">
          <span className="h-0.5 w-3 shrink-0 rounded-full bg-[var(--chart-ok)]" />
          <span className="tabular font-mono font-medium text-foreground">{formatDuration(point.avg_ms)}</span>
          <span className="text-muted-foreground">
            avg over {formatInt(executed)} call{executed === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </TooltipCard>
  )
}

// Average time per call, per bucket. One series, so one colour and no legend:
// the card's title says what is plotted.
export function LatencyChart({ series, range }: { series: StatsPoint[]; range: StatsRange }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(value: string) => bucketLabel(value, range)}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          minTickGap={36}
        />
        <YAxis
          width={48}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          tickFormatter={(value: number) => (value >= 1000 ? `${value / 1000} s` : `${value} ms`)}
        />
        <Tooltip
          content={<LatencyTip range={range} />}
          cursor={{ fill: 'var(--color-muted-foreground)', fillOpacity: 0.08 }}
          isAnimationActive={false}
        />
        <Bar dataKey="avg_ms" fill="var(--chart-ok)" maxBarSize={24} radius={[RADIUS, RADIUS, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}
