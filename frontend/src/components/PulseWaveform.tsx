import { useEffect, useRef, useState } from "react"
import { authClient } from "../lib/auth-client"
import { fetchDatabaseInstanceMetrics, fetchDatabaseInstances } from "../api/client"

const VIEW_WIDTH = 200
const VIEW_HEIGHT = 32
// Must evenly divide VIEW_WIDTH so the two tiled copies of the path seam
// together without a visible kink where they meet.
const PERIOD = 40
const BASE_AMPLITUDE = 10
const POLL_INTERVAL_MS = 5000

function buildWavePath(): string {
  const points: string[] = []
  for (let x = 0; x <= VIEW_WIDTH; x += 2) {
    const y = VIEW_HEIGHT / 2 + Math.sin((2 * Math.PI * x) / PERIOD) * BASE_AMPLITUDE
    points.push(`${x},${y.toFixed(2)}`)
  }
  return `M ${points.join(" L ")}`
}

const WAVE_PATH = buildWavePath()

// Live, data-driven signature element for the top status bar (Stage 5, Part
// A) — NOT a decorative animation. Polls the most recent active-connections
// sample (relative to max_connections, when known) for the org's first
// active database instance and maps that ratio onto the wave's vertical
// scale; only the scroll motion itself is a fixed-speed CSS loop.
export default function PulseWaveform() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const [amplitude, setAmplitude] = useState(0.12)
  const [connections, setConnections] = useState<number | null>(null)
  const instanceIdRef = useRef<string | null>(null)

  useEffect(() => {
    const orgId = activeOrg?.id
    if (!orgId) return
    let cancelled = false

    async function poll() {
      if (!instanceIdRef.current) {
        const instances = await fetchDatabaseInstances(orgId!)
        instanceIdRef.current = (instances.find((i) => i.status === "active") ?? instances[0])?.id ?? null
      }
      const instanceId = instanceIdRef.current
      if (!instanceId || cancelled) return

      const rows = await fetchDatabaseInstanceMetrics(orgId!, instanceId, 20)
      const latestActive = [...rows].reverse().find((m) => m.metricName === "active_connections")
      const latestMax = [...rows].reverse().find((m) => m.metricName === "max_connections")
      if (cancelled || !latestActive) return

      setConnections(latestActive.value)
      const ratio = latestMax?.value ? latestActive.value / latestMax.value : latestActive.value / 50
      setAmplitude(Math.min(1, Math.max(0.12, ratio)))
    }

    poll().catch(() => {})
    const interval = setInterval(() => poll().catch(() => {}), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeOrg?.id])

  return (
    <div className="flex items-center gap-2.5">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        <span className="font-display text-[10px] font-medium tracking-widest text-text-muted uppercase">Live</span>
      </span>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        width="140"
        height="24"
        preserveAspectRatio="none"
        className="overflow-visible"
        aria-hidden="true"
      >
        <g style={{ transformOrigin: "50% 50%", transform: `scaleY(${amplitude})`, transition: "transform 1.2s ease" }}>
          <g className="animate-pulse-scroll">
            <path d={WAVE_PATH} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
            <path
              d={WAVE_PATH}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.5"
              transform={`translate(${VIEW_WIDTH}, 0)`}
            />
          </g>
        </g>
      </svg>
      <span className="font-mono text-xs text-text-secondary">
        {connections === null ? "--" : connections} conn
      </span>
    </div>
  )
}
