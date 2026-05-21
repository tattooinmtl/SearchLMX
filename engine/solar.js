'use strict'

// NOAA Space Weather Prediction Center APIs (all free, no key needed)
// Updated May 2026 to match current SWPC endpoint formats
const NOAA = 'https://services.swpc.noaa.gov'

async function fetchAllSolarData() {
  const [xray, kp, wind, mag, flares, regions] = await Promise.allSettled([
    fetchXrayFlux(),
    fetchKpIndex(),
    fetchSolarWind(),
    fetchImfMag(),
    fetchRecentFlares(),
    fetchActiveRegions()
  ])

  // Merge wind + magnetic field data
  const windData = wind.status === 'fulfilled' ? wind.value : null
  const magData  = mag.status  === 'fulfilled' ? mag.value  : null

  const solarWind = windData ? {
    ...windData,
    bz: magData?.bz ?? null,
    bt: magData?.bt ?? null,
    bx: magData?.bx ?? null,
    by: magData?.by ?? null,
    timeSeries: windData.timeSeries.map((row, i) => ({
      ...row,
      bz: magData?.timeSeries?.[i]?.bz ?? null
    }))
  } : null

  return {
    xrayFlux:      xray.status    === 'fulfilled' ? xray.value    : null,
    kpIndex:       kp.status      === 'fulfilled' ? kp.value      : null,
    solarWind,
    flares:        flares.status  === 'fulfilled' ? flares.value  : [],
    activeRegions: regions.status === 'fulfilled' ? regions.value : [],
    fetchedAt:     new Date().toISOString()
  }
}

// GOES primary X-ray flux — last 24h, 1-minute cadence
// Long channel (0.1-0.8 nm) is the standard solar flare indicator
async function fetchXrayFlux() {
  const res = await fetch(`${NOAA}/json/goes/primary/xrays-1-day.json`, {
    signal: AbortSignal.timeout(14_000)
  })
  if (!res.ok) throw new Error(`NOAA xray ${res.status}`)
  const data = await res.json()

  // Both 0.05-0.4nm (short) and 0.1-0.8nm (long) channels are in the file
  const longChannel = data.filter(d => d.energy === '0.1-0.8nm')
  const useData = longChannel.length ? longChannel : data  // fallback to all if filter empty

  const latest = useData[useData.length - 1]
  const currentFlux = Number(latest?.observed_flux ?? latest?.flux ?? 0)

  return {
    current:    currentFlux,
    class:      fluxToClass(currentFlux),
    label:      fluxToLabel(currentFlux),
    timeSeries: useData.slice(-60).map(d => ({
      time: d.time_tag,
      flux: Number(d.observed_flux ?? d.flux ?? 0)
    }))
  }
}

// Planetary K-index — current format: array of objects {time_tag, Kp, ...}
async function fetchKpIndex() {
  const res = await fetch(
    `${NOAA}/products/noaa-planetary-k-index.json`,
    { signal: AbortSignal.timeout(12_000) }
  )
  if (!res.ok) throw new Error(`NOAA kp ${res.status}`)
  const raw = await res.json()

  // New format: [{time_tag, Kp, a_running, station_count}, ...]
  // Old format: [["time_tag","kp",...], [...]] (first row header)
  // Detect format and parse accordingly
  let rows
  if (Array.isArray(raw[0])) {
    // Old array-of-arrays format
    rows = raw.slice(1)
      .map(r => ({ time: r[0], kp: parseFloat(r[1]) }))
      .filter(r => Number.isFinite(r.kp))
  } else {
    // New object format
    rows = raw
      .map(r => ({ time: r.time_tag, kp: parseFloat(r.Kp ?? r.kp ?? r.value ?? 0) }))
      .filter(r => Number.isFinite(r.kp))
  }

  const recent     = rows.slice(-56)  // last 7 days (8 readings/day × 7)
  const last48     = recent.slice(-16) // last 48 hours (16 × 3h intervals)
  const rawCurrent = recent[recent.length - 1]?.kp
  const current    = Number.isFinite(rawCurrent) ? rawCurrent : 0

  return {
    current,
    stormLevel: kpToStormLevel(current),
    recent:     last48,
    timeSeries: recent
  }
}

// DSCOVR/ACE solar wind proton data — fields now prefixed with proton_
async function fetchSolarWind() {
  const res = await fetch(
    `${NOAA}/json/rtsw/rtsw_wind_1m.json`,
    { signal: AbortSignal.timeout(12_000) }
  )
  if (!res.ok) throw new Error(`NOAA wind ${res.status}`)
  const data = await res.json()

  const recent = data.slice(-60)
  const latest = data[data.length - 1] ?? {}

  // Field names updated: speed → proton_speed, density → proton_density
  const speed   = Number(latest.proton_speed   ?? latest.speed   ?? null)
  const density = Number(latest.proton_density ?? latest.density ?? null)
  const temp    = Number(latest.proton_temperature ?? latest.temperature ?? null)

  return {
    speed:       Number.isFinite(speed)   ? speed   : null,
    density:     Number.isFinite(density) ? density : null,
    temperature: Number.isFinite(temp)    ? temp    : null,
    timeSeries:  recent.map(d => ({
      time:    d.time_tag,
      speed:   Number(d.proton_speed   ?? d.speed   ?? null),
      density: Number(d.proton_density ?? d.density ?? null)
    }))
  }
}

// DSCOVR/ACE interplanetary magnetic field — separate endpoint for Bz/Bt
async function fetchImfMag() {
  const res = await fetch(
    `${NOAA}/json/rtsw/rtsw_mag_1m.json`,
    { signal: AbortSignal.timeout(12_000) }
  )
  if (!res.ok) throw new Error(`NOAA mag ${res.status}`)
  const data = await res.json()

  const recent = data.slice(-60)
  const latest = data[data.length - 1] ?? {}

  return {
    bz: Number.isFinite(Number(latest.bz_gsm)) ? Number(latest.bz_gsm) : null,
    bt: Number.isFinite(Number(latest.bt))      ? Number(latest.bt)     : null,
    bx: Number.isFinite(Number(latest.bx_gsm)) ? Number(latest.bx_gsm) : null,
    by: Number.isFinite(Number(latest.by_gsm)) ? Number(latest.by_gsm) : null,
    timeSeries: recent.map(d => ({
      time: d.time_tag,
      bz:   Number(d.bz_gsm ?? 0),
      bt:   Number(d.bt ?? 0)
    }))
  }
}

// X-ray flare events from GOES — last 7 days
// Fields updated: classType → max_class, beginTime → begin_time, etc.
async function fetchRecentFlares() {
  const res = await fetch(
    `${NOAA}/json/goes/primary/xray-flares-7-day.json`,
    { signal: AbortSignal.timeout(12_000) }
  )
  if (!res.ok) throw new Error(`NOAA flares ${res.status}`)
  const data = await res.json()

  return data.map(f => ({
    classType:  f.max_class    ?? f.class_letter  ?? 'A',
    beginTime:  f.begin_time   ?? f.beginTime,
    maxTime:    f.max_time     ?? f.maxTime,
    endTime:    f.end_time     ?? f.endTime,
    peakFlux:   f.max_xrlong  ?? null,
    region:     f.linked_region ?? f.region ?? 'unknown',
    satellite:  f.satellite    ?? 'GOES'
  })).filter(f => f.beginTime)
}

// Active solar regions (sunspot groups)
async function fetchActiveRegions() {
  const res = await fetch(
    `${NOAA}/json/solar_regions.json`,
    { signal: AbortSignal.timeout(10_000) }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data ?? []).slice(0, 10).map(r => ({
    region:   r.region  ?? r.number,
    location: r.location ?? '--',
    area:     r.area ?? 0,
    classZ:   r.z_class  ?? r.classification ?? '--',
    classMag: r.mag_class ?? '--',
    cFlares:  parseInt(r.c_xray_events ?? 0),
    mFlares:  parseInt(r.m_xray_events ?? 0),
    xFlares:  parseInt(r.x_xray_events ?? 0)
  }))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fluxToClass(flux) {
  if (!flux || flux <= 0) return 'A'
  if (flux >= 1e-4) return 'X'
  if (flux >= 1e-5) return 'M'
  if (flux >= 1e-6) return 'C'
  if (flux >= 1e-7) return 'B'
  return 'A'
}

function fluxToLabel(flux) {
  const cls = fluxToClass(flux)
  if (!flux || flux <= 0) return 'A0.0'
  const multipliers = { X: 1e-4, M: 1e-5, C: 1e-6, B: 1e-7, A: 1e-8 }
  const sub = (flux / multipliers[cls]).toFixed(1)
  return `${cls}${sub}`
}

function kpToStormLevel(kp) {
  if (kp >= 9) return 'Extreme (G5)'
  if (kp >= 8) return 'Severe (G4)'
  if (kp >= 7) return 'Strong (G3)'
  if (kp >= 6) return 'Moderate (G2)'
  if (kp >= 5) return 'Minor (G1)'
  if (kp >= 4) return 'Active'
  if (kp >= 3) return 'Unsettled'
  return 'Quiet'
}

function calculateSolarActivityScore(data) {
  let score = 10
  const cls = data?.xrayFlux?.class ?? 'A'
  const classBonus = { X: 90, M: 60, C: 30, B: 12, A: 5 }
  score = Math.max(score, classBonus[cls[0]] ?? 5)
  const significant = (data?.flares ?? []).filter(f => ['M','X'].includes((f.classType ?? '')[0]))
  score = Math.min(100, score + significant.length * 4)
  return Math.round(score)
}

function calculateGeomagneticScore(data) {
  const kp = data?.kpIndex?.current ?? 0
  let score = (kp / 9) * 80
  const highKp = (data?.kpIndex?.recent ?? []).filter(k => k.kp >= 5).length
  score = Math.min(100, score + highKp * 2)
  return Math.round(score)
}

module.exports = {
  fetchAllSolarData,
  calculateSolarActivityScore,
  calculateGeomagneticScore,
  fluxToClass,
  fluxToLabel,
  kpToStormLevel
}
