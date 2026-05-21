'use strict'

const { haversine, extractRegion } = require('./sources')

// ── Configuration ─────────────────────────────────────────────────────────────

const DIST_KM      = 100   // max km radius of a cluster from its anchor
const MIN_EVENTS   = 5     // minimum events to be a swarm
const TREND_WINDOW = 12    // hours: compare last N hours vs previous N hours

// ── Main detection ────────────────────────────────────────────────────────────

function detectSwarms(quakes, opts = {}) {
  const distKm   = opts.distKm   ?? DIST_KM
  const minCount = opts.minCount ?? MIN_EVENTS

  // Work oldest-first so anchor = first event in sequence
  const sorted = [...quakes].sort((a, b) => new Date(a.time) - new Date(b.time))

  const clusters = []

  for (const q of sorted) {
    let assigned = false
    for (const cl of clusters) {
      if (haversine(cl.anchor.lat, cl.anchor.lon, q.lat, q.lon) <= distKm) {
        cl.events.push(q)
        assigned = true
        break
      }
    }
    if (!assigned) {
      clusters.push({ anchor: q, events: [q] })
    }
  }

  return clusters
    .filter(cl => cl.events.length >= minCount)
    .map(cl => buildSwarm(cl))
    .sort((a, b) => {
      // Sort: severity first, then most recent
      const sevOrder = { HIGH: 0, ELEVATED: 1, MODERATE: 2, ACTIVE: 3 }
      const sd = (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9)
      if (sd !== 0) return sd
      return new Date(b.lastTime) - new Date(a.lastTime)
    })
}

// ── Build swarm object ────────────────────────────────────────────────────────

function buildSwarm(cl) {
  const events   = cl.events
  const mags     = events.map(e => e.mag).sort((a, b) => b - a)
  const maxMag   = mags[0] ?? 0
  const minMag   = mags[mags.length - 1] ?? 0
  const times    = events.map(e => new Date(e.time).getTime()).sort((a, b) => a - b)
  const firstTime = new Date(times[0]).toISOString()
  const lastTime  = new Date(times[times.length - 1]).toISOString()
  const durationH = (times[times.length - 1] - times[0]) / 3_600_000

  // Centroid
  const lat = events.reduce((s, e) => s + e.lat, 0) / events.length
  const lon = events.reduce((s, e) => s + e.lon, 0) / events.length

  // Place name from largest event
  const largestEvent = events.reduce((best, e) => e.mag > best.mag ? e : best, events[0])
  const region = extractRegion(largestEvent.place) || largestEvent.place || 'Unknown'

  const type      = classifySwarm(mags)
  const trend     = getTrend(events)
  const severity  = getSeverity(maxMag, events.length)

  const sourcesSet = new Set(events.map(e => e.source).filter(Boolean))

  // Active if last event in last 24h
  const nowMs   = Date.now()
  const lastMs  = times[times.length - 1]
  const isActive = (nowMs - lastMs) < 86_400_000

  return {
    id:           `swarm-${cl.anchor.lat.toFixed(2)}-${cl.anchor.lon.toFixed(2)}`,
    type,
    severity,
    trend,
    isActive,
    region,
    place:        largestEvent.place,
    lat:          parseFloat(lat.toFixed(3)),
    lon:          parseFloat(lon.toFixed(3)),
    count:        events.length,
    maxMag:       parseFloat(maxMag.toFixed(1)),
    minMag:       parseFloat(minMag.toFixed(1)),
    mainshockMag: type === 'AFTERSHOCK' ? parseFloat(maxMag.toFixed(1)) : null,
    avgDepth:     parseFloat((events.reduce((s, e) => s + (e.depth ?? 0), 0) / events.length).toFixed(1)),
    firstTime,
    lastTime,
    durationH:    parseFloat(durationH.toFixed(1)),
    sources:      [...sourcesSet]
  }
}

// ── Classification ────────────────────────────────────────────────────────────

function classifySwarm(sortedMags) {
  if (sortedMags.length < 2) return 'CLUSTER'
  const max = sortedMags[0]
  const second = sortedMags[1]
  // Clear mainshock: M5.0+ and at least 1.5 larger than second largest
  if (max >= 5.0 && (max - second) >= 1.5) return 'AFTERSHOCK'
  // Tight magnitude band = swarm (volcanic/fluid-induced)
  if ((max - sortedMags[sortedMags.length - 1]) < 1.5) return 'SWARM'
  return 'SEQUENCE'
}

function getSeverity(maxMag, count) {
  if (maxMag >= 6.0 || count >= 50)  return 'HIGH'
  if (maxMag >= 5.0 || count >= 20)  return 'ELEVATED'
  if (maxMag >= 4.0 || count >= 10)  return 'MODERATE'
  return 'ACTIVE'
}

function getTrend(events) {
  const now      = Date.now()
  const windowMs = TREND_WINDOW * 3_600_000
  const recent   = events.filter(e => (now - new Date(e.time).getTime()) < windowMs).length
  const older    = events.filter(e => {
    const age = now - new Date(e.time).getTime()
    return age >= windowMs && age < windowMs * 2
  }).length

  if (recent === 0 && older === 0) return 'STABLE'
  if (older === 0) return recent > 0 ? 'ACCELERATING' : 'STABLE'
  const ratio = recent / (older || 1)
  if (ratio > 1.5) return 'ACCELERATING'
  if (ratio < 0.5) return 'DECELERATING'
  return 'STABLE'
}

module.exports = { detectSwarms }
