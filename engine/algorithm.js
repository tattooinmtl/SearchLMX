'use strict'

// SearchLMx Custom Seismic Risk Algorithm v1.0
//
// Factors (weighted composite):
//  30% — Tidal stress (Moon + Sun alignment, distance, planetary)
//  20% — Solar X-ray / flare activity
//  15% — Geomagnetic disturbance (Kp index)
//  10% — Planetary gravitational alignment
//  25% — Historical seismic pattern in last 24h

const REGIONS = [
  { name: 'Japan / Kuril Islands',          lat: [30, 50],  lon: [130, 155], base: 0.88 },
  { name: 'Indonesia / Philippines',        lat: [-10, 20], lon: [95,  145], base: 0.90 },
  { name: 'Chile / Peru',                   lat: [-55, -5], lon: [-82, -65], base: 0.82 },
  { name: 'Alaska / Aleutian Islands',      lat: [50,  65], lon: [-180,-130],base: 0.72 },
  { name: 'Central America / Mexico',       lat: [8,   22], lon: [-100,-84], base: 0.68 },
  { name: 'California / Cascadia',          lat: [32,  50], lon: [-125,-114],base: 0.65 },
  { name: 'New Zealand / Tonga / Vanuatu',  lat: [-50,-10], lon: [165, 185], base: 0.78 },
  { name: 'Himalayan Belt / Hindu Kush',    lat: [25,  40], lon: [62,  100], base: 0.62 },
  { name: 'Mediterranean / Middle East',    lat: [28,  45], lon: [-10,  55], base: 0.58 },
  { name: 'Caribbean Arc',                  lat: [10,  22], lon: [-85, -58], base: 0.52 },
  { name: 'Mid-Atlantic Ridge',             lat: [-60, 70], lon: [-50, -15], base: 0.42 },
  { name: 'Iran / Turkey / Caucasus',       lat: [35,  45], lon: [40,   65], base: 0.60 }
]

function runRiskAlgorithm(quakeData, solarData, planetaryData) {
  // ── Individual factor scores (0-100) ───────────────────────────────────────
  const tidalScore       = scoreTidal(planetaryData)
  const solarScore       = scoreSolar(solarData)
  const geomagScore      = scoreGeomagnetic(solarData)
  const planetaryScore   = planetaryData?.alignmentScore ?? 10
  const historicalScore  = scoreHistorical(quakeData)

  // ── Weighted composite ────────────────────────────────────────────────────
  const composite =
    tidalScore      * 0.30 +
    solarScore      * 0.20 +
    geomagScore     * 0.15 +
    planetaryScore  * 0.10 +
    historicalScore * 0.25

  const overall = {
    score: Math.round(composite),
    level: riskLevel(composite),
    color: riskColor(composite)
  }

  const factors = {
    tidal:      Math.round(tidalScore),
    solar:      Math.round(solarScore),
    geomagnetic:Math.round(geomagScore),
    planetary:  Math.round(planetaryScore),
    historical: Math.round(historicalScore)
  }

  const regions = scoreRegions(quakeData, factors)

  return {
    timestamp: new Date().toISOString(),
    overall,
    factors,
    regions
  }
}

// ── Factor scorers ────────────────────────────────────────────────────────────

function scoreTidal(planetary) {
  if (!planetary?.tidal) return 40

  const base = parseFloat(planetary.tidal.combinedIndex) || 40

  // Perigean spring tide is extra dangerous
  const isSpring  = planetary.tidal.type === 'Spring'
  const isPerigee = planetary.moon?.isPerigee === true
  const isPerihelion = planetary.sun?.isNearPerihelion === true

  let boost = 0
  if (isSpring && isPerigee) boost += 15
  else if (isSpring)         boost += 8
  if (isPerihelion)          boost += 5

  return Math.min(100, base + boost)
}

function scoreSolar(solar) {
  if (!solar?.xrayFlux) return 15

  const classScores = { X: 95, M: 65, C: 35, B: 15, A: 8 }
  const cls = (solar.xrayFlux.class ?? 'A')[0]
  let score = classScores[cls] ?? 8

  // Recent M+ flares add accumulated stress
  const significant = (solar.flares ?? []).filter(f =>
    ['M', 'X'].includes((f.classType ?? '')[0])
  )
  score = Math.min(100, score + significant.length * 3)

  return Math.round(score)
}

function scoreGeomagnetic(solar) {
  if (!solar?.kpIndex) return 15

  const kp = Number.isFinite(solar.kpIndex.current) ? solar.kpIndex.current : 0
  let score = (kp / 9) * 80

  // Sustained elevated Kp adds extra weight
  const recentHigh = (solar.kpIndex.recent ?? []).filter(k => k.kp >= 5).length
  score = Math.min(100, score + recentHigh * 1.5)

  return Math.round(score)
}

function scoreHistorical(quakeData) {
  if (!quakeData?.quakes) return 25

  const { quakes, pattern } = quakeData
  const count  = pattern?.totalCount ?? quakes.length
  const rawMax = pattern?.maxMag
  const maxMag = (rawMax != null && Number.isFinite(rawMax)) ? rawMax : 0

  // Base from frequency (~100-200 M2.5+ per day is typical globally)
  let score = Math.min(50, (count / 200) * 50)

  // Magnitude boosts
  if      (maxMag >= 7.5) score = Math.min(100, score + 45)
  else if (maxMag >= 7.0) score = Math.min(100, score + 35)
  else if (maxMag >= 6.5) score = Math.min(100, score + 25)
  else if (maxMag >= 6.0) score = Math.min(100, score + 15)
  else if (maxMag >= 5.5) score = Math.min(100, score + 8)
  else if (maxMag >= 5.0) score = Math.min(100, score + 4)

  // Tsunami alerts are a major escalation signal
  if ((pattern?.tsunamiAlerts ?? 0) > 0) score = Math.min(100, score + 20)

  return Math.round(score)
}

function scoreRegions(quakeData, factors) {
  const baseFromGlobal = (
    factors.tidal      * 0.35 +
    factors.solar      * 0.20 +
    factors.geomagnetic* 0.15 +
    factors.planetary  * 0.10
  )

  return REGIONS.map(region => {
    const regionalQuakes = (quakeData?.quakes ?? []).filter(q =>
      q.lat >= region.lat[0] && q.lat <= region.lat[1] &&
      q.lon >= region.lon[0] && q.lon <= region.lon[1]
    )

    const qCount = regionalQuakes.length
    const qMaxMag = qCount > 0 ? Math.max(...regionalQuakes.map(q => q.mag)) : 0
    const qHasTsunami = regionalQuakes.some(q => q.tsunami)

    let score = baseFromGlobal * region.base
    score += qCount * 0.4
    score += qMaxMag * 3
    if (qHasTsunami) score += 15

    score = Math.min(100, Math.max(0, score))

    return {
      region:    region.name,
      score:     Math.round(score),
      level:     riskLevel(score),
      color:     riskColor(score),
      quakeCount:qCount,
      maxMag:    qMaxMag.toFixed(1),
      tsunami:   qHasTsunami
    }
  }).sort((a, b) => b.score - a.score)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function riskLevel(score) {
  if (score >= 75) return 'HIGH'
  if (score >= 50) return 'ELEVATED'
  if (score >= 25) return 'MODERATE'
  return 'LOW'
}

function riskColor(score) {
  if (score >= 75) return '#ef4444'
  if (score >= 50) return '#f97316'
  if (score >= 25) return '#f59e0b'
  return '#22c55e'
}

module.exports = { runRiskAlgorithm, REGIONS }
