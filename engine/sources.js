'use strict'

// Multi-network FDSN earthquake fetcher
// All sources use standard FDSN GeoJSON format (format=geojson)
// China & Russia: no public real-time API — covered by USGS global catalog (M4.5+)

const SOURCES = {
  usgs: {
    name: 'USGS',   region: 'Global',
    url:  'https://earthquake.usgs.gov/fdsnws/event/1/query',
    timeout: 22000, limit: 2000, minMagFloor: 0, priority: 1
  },
  emsc: {
    name: 'EMSC',   region: 'Europe/Global',
    url:  'https://www.seismicportal.eu/fdsnws/event/1/query',
    timeout: 12000, limit: 1000, minMagFloor: 3.5, priority: 2
  },
  ingv: {
    name: 'INGV',   region: 'Italy',
    url:  'https://webservices.ingv.it/fdsnws/event/1/query',
    timeout: 18000, limit: 1000, minMagFloor: 0, priority: 2
  },
  nrcan: {
    name: 'NRCan',  region: 'Canada',
    url:  'https://earthquakescanada.nrcan.gc.ca/fdsnws/event/1/query',
    timeout: 18000, limit: 1000, minMagFloor: 0, priority: 2
  },
  gfz: {
    name: 'GFZ',    region: 'Europe/Global',
    url:  'https://geofon.gfz-potsdam.de/fdsnws/event/1/query',
    timeout: 12000, limit: 800,  minMagFloor: 3.0, priority: 3
  },
  ncedc: {
    name: 'NCEDC',  region: 'N. California',
    url:  'http://service.ncedc.org/fdsnws/event/1/query',
    timeout: 15000, limit: 1000, minMagFloor: 0, priority: 3
  }
}

// ── Fetching ──────────────────────────────────────────────────────────────────

async function fetchFdsn(sourceId, hours, minMag) {
  const src = SOURCES[sourceId]
  if (!src) throw new Error(`Unknown source: ${sourceId}`)

  const actualMinMag = Math.max(minMag, src.minMagFloor)
  const end   = new Date()
  const start = new Date(end.getTime() - hours * 3_600_000)

  const params = new URLSearchParams({
    format:         'geojson',
    starttime:      start.toISOString().slice(0, 19),
    endtime:        end.toISOString().slice(0, 19),
    minmagnitude:   actualMinMag,
    orderby:        'time',
    limit:          src.limit
  })

  const res = await fetch(`${src.url}?${params}`, {
    signal: AbortSignal.timeout(src.timeout)
  })
  if (!res.ok) throw new Error(`${src.name} returned HTTP ${res.status}`)

  const json = await res.json()
  return (json.features ?? [])
    .map(f => parseFdsnFeature(f, sourceId, src.name))
    .filter(q => q !== null)
}

function parseFdsnFeature(f, sourceId, sourceName) {
  try {
    const p = f.properties ?? {}
    const c = f.geometry?.coordinates ?? []
    const lat = Number(c[1]), lon = Number(c[0]), depth = Number(c[2] ?? 0)
    const mag = Number(p.mag ?? 0)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

    const rawTime = p.time
    const time = typeof rawTime === 'number'
      ? new Date(rawTime).toISOString()
      : new Date(rawTime ?? 0).toISOString()

    // USGS IDs kept without prefix for backward-compat with existing DB entries
    const eventId = sourceId === 'usgs'
      ? (f.id ?? `usgs-${lat.toFixed(3)}-${lon.toFixed(3)}-${rawTime}`)
      : `${sourceId}-${f.id ?? `${lat.toFixed(3)}-${lon.toFixed(3)}-${rawTime}`}`

    return {
      id:       eventId,
      mag:      Number.isFinite(mag) ? mag : 0,
      place:    p.place ?? p.flynn_region ?? p.description ?? 'Unknown',
      lat, lon, depth, time,
      tsunami:  p.tsunami === 1,
      felt:     Number(p.felt ?? 0) || 0,
      source:   sourceName,
      sourceId
    }
  } catch {
    return null
  }
}

// ── Merge & dedup ─────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(Math.min(1, a)))
}

function mergeAll(arrays) {
  // Flatten sorted by priority (USGS first), then dedup by proximity
  const all = arrays.flat().sort((a, b) => {
    const pa = SOURCES[a.sourceId]?.priority ?? 9
    const pb = SOURCES[b.sourceId]?.priority ?? 9
    return pa - pb
  })

  const kept = []
  for (const q of all) {
    const tq = new Date(q.time).getTime()
    const dup = kept.some(k => {
      const tk = new Date(k.time).getTime()
      return Math.abs(tk - tq) < 90_000 && haversine(k.lat, k.lon, q.lat, q.lon) < 25
    })
    if (!dup) kept.push(q)
  }

  return kept.sort((a, b) => new Date(b.time) - new Date(a.time))
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchAllSources(hours, minMag, sourceIds = Object.keys(SOURCES)) {
  const results = await Promise.allSettled(
    sourceIds.map(id => fetchFdsn(id, hours, minMag).catch(e => {
      console.warn(`[sources] ${id} failed: ${e.message}`)
      return []
    }))
  )
  const arrays = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
  return mergeAll(arrays)
}

// ── Pattern analysis (used by simulation + dashboard) ─────────────────────────

function analyzePattern(quakes) {
  if (!quakes.length) {
    return { totalCount: 0, maxMag: 0, activeRegions: [], tsunamiAlerts: 0, magBuckets: {} }
  }

  const maxMag = quakes.length > 0 ? Math.max(...quakes.map(q => q.mag)) : 0

  const regionCounts = {}
  for (const q of quakes) {
    const r = extractRegion(q.place)
    regionCounts[r] = (regionCounts[r] ?? 0) + 1
  }

  const activeRegions = Object.entries(regionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }))

  const magBuckets = { '0-1': 0, '1-2': 0, '2-3': 0, '3-4': 0, '4-5': 0, '5-6': 0, '6-7': 0, '7+': 0 }
  for (const q of quakes) {
    if      (q.mag < 1) magBuckets['0-1']++
    else if (q.mag < 2) magBuckets['1-2']++
    else if (q.mag < 3) magBuckets['2-3']++
    else if (q.mag < 4) magBuckets['3-4']++
    else if (q.mag < 5) magBuckets['4-5']++
    else if (q.mag < 6) magBuckets['5-6']++
    else if (q.mag < 7) magBuckets['6-7']++
    else                magBuckets['7+']++
  }

  return { totalCount: quakes.length, maxMag, activeRegions, tsunamiAlerts: quakes.filter(q => q.tsunami).length, magBuckets }
}

function extractRegion(place) {
  if (!place) return 'Unknown'
  const parts = place.split(', ')
  return parts.length > 1 ? parts[parts.length - 1] : place
}

// Backward-compatible wrapper (used by usgs.js → simulation.js)
async function fetchRecentQuakes(hours = 24, minMag = 2.5) {
  const quakes  = await fetchAllSources(hours, minMag, ['usgs', 'emsc'])
  const pattern = analyzePattern(quakes)
  return { quakes, pattern, fetchedAt: new Date().toISOString(), source: 'USGS+EMSC' }
}

module.exports = {
  SOURCES,
  fetchFdsn,
  fetchAllSources,
  fetchRecentQuakes,
  mergeAll,
  analyzePattern,
  haversine,
  extractRegion
}
