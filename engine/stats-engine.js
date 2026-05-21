'use strict'

// Pure stats computation — no I/O, works on any quake array

function computeStats(quakes, opts = {}) {
  const totalHours = opts.totalHours ?? 24

  if (!quakes.length) return emptyStats()

  const mags   = quakes.map(q => q.mag).filter(Number.isFinite)
  const depths = quakes.map(q => q.depth ?? 0).filter(Number.isFinite)
  const maxMag  = mags.length ? Math.max(...mags) : 0
  const avgMag  = mags.length ? mags.reduce((s, v) => s + v, 0) / mags.length : 0
  const avgDepth = depths.length ? depths.reduce((s, v) => s + v, 0) / depths.length : 0

  const byMag = { '0-1': 0, '1-2': 0, '2-3': 0, '3-4': 0, '4-5': 0, '5-6': 0, '6-7': 0, '7+': 0 }
  for (const m of mags) {
    if      (m < 1) byMag['0-1']++
    else if (m < 2) byMag['1-2']++
    else if (m < 3) byMag['2-3']++
    else if (m < 4) byMag['3-4']++
    else if (m < 5) byMag['4-5']++
    else if (m < 6) byMag['5-6']++
    else if (m < 7) byMag['6-7']++
    else            byMag['7+']++
  }

  const depthBuckets = { 'Shallow (0–70 km)': 0, 'Intermediate (70–300 km)': 0, 'Deep (300+ km)': 0 }
  for (const d of depths) {
    if      (d < 70)  depthBuckets['Shallow (0–70 km)']++
    else if (d < 300) depthBuckets['Intermediate (70–300 km)']++
    else              depthBuckets['Deep (300+ km)']++
  }

  const bySource = {}
  for (const q of quakes) {
    const s = q.source ?? 'Unknown'
    bySource[s] = (bySource[s] ?? 0) + 1
  }

  const regionCounts = {}
  for (const q of quakes) {
    const r = extractRegion(q.place)
    regionCounts[r] = (regionCounts[r] ?? 0) + 1
  }
  const topRegions = Object.entries(regionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }))

  const timeSeries = buildTimeSeries(quakes, totalHours)
  const trend      = computeTrend(quakes, totalHours)

  return {
    total:    quakes.length,
    byMag,
    thresholds: {
      m2:  quakes.filter(q => q.mag >= 2.0).length,
      m3:  quakes.filter(q => q.mag >= 3.0).length,
      m4:  quakes.filter(q => q.mag >= 4.0).length,
      m5:  quakes.filter(q => q.mag >= 5.0).length,
      m6:  quakes.filter(q => q.mag >= 6.0).length,
      m7:  quakes.filter(q => q.mag >= 7.0).length
    },
    maxMag:        parseFloat(maxMag.toFixed(1)),
    avgMag:        parseFloat(avgMag.toFixed(2)),
    avgDepth:      parseFloat(avgDepth.toFixed(1)),
    tsunamiCount:  quakes.filter(q => q.tsunami).length,
    bySource,
    topRegions,
    depthBuckets,
    timeSeries,
    trend,
    computedAt: new Date().toISOString()
  }
}

// ── Time series ───────────────────────────────────────────────────────────────

function buildTimeSeries(quakes, totalHours) {
  const now = Date.now()

  if (totalHours <= 72) {
    // Hourly buckets
    const buckets = Array.from({ length: Math.min(totalHours, 48) }, (_, i) => {
      const bucketStart = new Date(now - (totalHours - i) * 3_600_000)
      const bucketEnd   = new Date(now - (totalHours - i - 1) * 3_600_000)
      const label = bucketStart.toISOString().slice(11, 16) + ' UTC'
      return { label, count: 0, start: bucketStart.getTime(), end: bucketEnd.getTime() }
    })
    for (const q of quakes) {
      const t = new Date(q.time).getTime()
      for (const b of buckets) {
        if (t >= b.start && t < b.end) { b.count++; break }
      }
    }
    return buckets.map(b => ({ label: b.label, count: b.count }))
  }

  // Daily buckets for longer ranges
  const days = Math.ceil(totalHours / 24)
  const buckets = Array.from({ length: days }, (_, i) => {
    const bucketStart = new Date(now - (days - i) * 86_400_000)
    const bucketEnd   = new Date(now - (days - i - 1) * 86_400_000)
    const label = bucketStart.toISOString().slice(0, 10)
    return { label, count: 0, start: bucketStart.getTime(), end: bucketEnd.getTime() }
  })
  for (const q of quakes) {
    const t = new Date(q.time).getTime()
    for (const b of buckets) {
      if (t >= b.start && t < b.end) { b.count++; break }
    }
  }
  return buckets.map(b => ({ label: b.label, count: b.count }))
}

// Compare first half vs second half of the time window
function computeTrend(quakes, totalHours) {
  const now    = Date.now()
  const halfMs = (totalHours / 2) * 3_600_000
  const recent = quakes.filter(q => (now - new Date(q.time).getTime()) < halfMs).length
  const older  = quakes.filter(q => {
    const age = now - new Date(q.time).getTime()
    return age >= halfMs && age < halfMs * 2
  }).length

  if (older === 0 && recent === 0) return { direction: 'flat', pct: 0 }
  if (older === 0) return { direction: 'up', pct: 100 }

  const pct = Math.round(((recent - older) / older) * 100)
  return {
    direction: pct > 10 ? 'up' : pct < -10 ? 'down' : 'flat',
    pct
  }
}

function extractRegion(place) {
  if (!place) return 'Unknown'
  const parts = place.split(', ')
  return parts.length > 1 ? parts[parts.length - 1] : place
}

function emptyStats() {
  return {
    total: 0, byMag: {}, thresholds: { m2: 0, m3: 0, m4: 0, m5: 0, m6: 0, m7: 0 },
    maxMag: 0, avgMag: 0, avgDepth: 0, tsunamiCount: 0,
    bySource: {}, topRegions: [], depthBuckets: {}, timeSeries: [],
    trend: { direction: 'flat', pct: 0 }, computedAt: new Date().toISOString()
  }
}

module.exports = { computeStats }
