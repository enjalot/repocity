import { useMemo } from 'react'
import type { Replay } from './city/model'

/** A fixed-size overview: large histories do not create one DOM node per commit. */
export function HistoryTimeline({ replay, eventIndex, onSeek }: {
  replay: Replay
  eventIndex: number
  onSeek: (index: number) => void
}) {
  const overview = useMemo(() => {
    const count = Math.min(240, replay.events.length)
    const bins = Array.from({ length: count }, () => ({ add: 0, remove: 0 }))
    replay.events.forEach((event, index) => {
      const bin = bins[Math.floor(index * count / replay.events.length)]
      for (const [pathId, additions, removals] of event.changes) {
        const category = replay.paths[pathId]?.category
        if (category !== 'source' && category !== 'test') continue
        bin.add += additions
        bin.remove += removals
      }
    })
    const max = Math.max(1, ...bins.flatMap(bin => [bin.add, bin.remove]))
    const path = (direction: 'add' | 'remove') => bins.map((bin, index) => {
      const height = Math.log1p(bin[direction]) / Math.log1p(max) * 27
      const x = index / count * 1000
      const width = Math.max(1, 1000 / count - 1)
      const signed = direction === 'add' ? -height : height
      return `M${x},30v${signed}h${width}v${-signed}Z`
    }).join('')
    return { add: path('add'), remove: path('remove'), count, max }
  }, [replay])
  const current = eventIndex / Math.max(1, replay.events.length - 1) * 1000
  const seek = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    onSeek(Math.round(fraction * (replay.events.length - 1)))
  }
  const date = (index: number) => new Date(replay.events[index].committedAt)
    .toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  return (
    <div className="history-overview">
      <div className="history-caption">
        <span><span className="addition">+ Additions</span> / <span className="removal">− Removals</span></span>
        <span>source + tests · log LOC · up to {Math.ceil(replay.events.length / overview.count)} commits/bar</span>
      </div>
      <svg viewBox="0 0 1000 60" preserveAspectRatio="none" role="img"
        aria-label="Source and test additions above the baseline, removals below. Bar heights use the same logarithmic LOC scale. Click or drag to seek; the slider below supports keyboard navigation."
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); seek(event) }}
        onPointerMove={(event) => { if (event.buttons) seek(event) }}>
        <title>Commits in order; the largest bar represents {overview.max.toLocaleString()} LOC. Additions and removals share a logarithmic scale.</title>
        <path d={overview.add} className="history-add" />
        <path d={overview.remove} className="history-remove" />
        <line x1={0} x2={1000} y1={30} y2={30} className="history-baseline" />
        <line x1={current} x2={current} y1={0} y2={60} className="history-cursor" />
      </svg>
      <div className="history-dates"><span>{date(0)}</span><span>{date(replay.events.length - 1)}</span></div>
    </div>
  )
}
