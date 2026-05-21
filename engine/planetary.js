'use strict'

const Astronomy = require('astronomy-engine')

// Planetary masses relative to Moon (for tidal force calculations)
// Tidal force ∝ M/D³  — ratio relative to Moon at mean distance
const TIDAL_RATIOS = {
  // Sun's tidal effect is 46% of Moon's at mean distances
  Sun:     0.459,
  Jupiter: 0.0000839,
  Saturn:  0.0000177,
  Venus:   0.0000113,
  Mars:    0.0000029
}

const MOON_MEAN_DIST_KM = 384_400
const AU_KM = 149_597_870.7

function getCurrentPlanetaryData() {
  const date = new Date()
  const time = Astronomy.MakeTime(date)

  // ── Moon ────────────────────────────────────────────────────────────────────
  const moonPhase = Astronomy.MoonPhase(time)
  const moonVec   = Astronomy.GeoVector('Moon', time, false)
  const moonDistAU = vecLen(moonVec)
  const moonDistKm = moonDistAU * AU_KM
  const moonIllum  = Astronomy.Illumination('Moon', time)

  // ── Sun ─────────────────────────────────────────────────────────────────────
  const sunVec   = Astronomy.GeoVector('Sun', time, false)
  const sunDistAU = vecLen(sunVec)

  // ── Planets ─────────────────────────────────────────────────────────────────
  const planetNames = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']
  const planets = {}
  for (const name of planetNames) {
    const vec  = Astronomy.GeoVector(name, time, false)
    const dist = vecLen(vec)
    let elong = null
    try { elong = Astronomy.Elongation(name, time) } catch { /* inner planets may throw */ }
    planets[name.toLowerCase()] = {
      distanceAU:   dist,
      distanceKm:   dist * AU_KM,
      elongation:   elong?.elongation ?? null,
      elongationDir:elong?.vis_illumination > 0 ? 'East' : 'West'
    }
  }

  // ── Tidal stress ─────────────────────────────────────────────────────────────
  const tidal = calculateTidal(moonDistKm, sunDistAU, moonPhase, planets)

  // ── Planetary alignment score ─────────────────────────────────────────────
  const alignmentScore = calculateAlignmentScore(planets)

  return {
    timestamp: date.toISOString(),
    moon: {
      phaseAngle:   moonPhase,
      phaseName:    phaseName(moonPhase),
      illumination: moonIllum.phase_fraction * 100,
      distanceKm:   moonDistKm,
      distanceAU:   moonDistAU,
      isPerigee:    moonDistKm < 370_000,
      isApogee:     moonDistKm > 400_000
    },
    sun: {
      distanceAU: sunDistAU,
      distanceKm: sunDistAU * AU_KM,
      isNearPerihelion: sunDistAU < 0.99
    },
    ...planets,
    tidal,
    alignmentScore
  }
}

function calculateTidal(moonDistKm, sunDistAU, moonPhase, planets) {
  // Moon tidal force relative to its own average (1.0 = average Moon tidal)
  const moonTidal = Math.pow(MOON_MEAN_DIST_KM / moonDistKm, 3)

  // Sun tidal force relative to Moon's average
  const sunTidal = TIDAL_RATIOS.Sun * Math.pow(1.0 / sunDistAU, 3)

  // Phase angle between Moon and Sun (0° = new moon, 180° = full moon — both spring tides)
  const phaseRad = (moonPhase * Math.PI) / 180

  // Resultant tidal vector magnitude
  // When aligned (phase=0° or 180°): vectors add → spring tide
  // When perpendicular (phase=90° or 270°): vectors partially cancel → neap tide
  const totalX = moonTidal + sunTidal * Math.cos(phaseRad)
  const totalY = sunTidal * Math.sin(phaseRad)
  const combined = Math.sqrt(totalX * totalX + totalY * totalY)

  // Add minor planetary contributions
  const jupiterDistAU = planets.jupiter?.distanceAU ?? 5.2
  const venusDistAU   = planets.venus?.distanceAU ?? 0.7
  const marsDistAU    = planets.mars?.distanceAU ?? 1.5
  const planetaryBonus =
    TIDAL_RATIOS.Jupiter * Math.pow(1 / jupiterDistAU, 3) +
    TIDAL_RATIOS.Venus   * Math.pow(1 / venusDistAU, 3) +
    TIDAL_RATIOS.Mars    * Math.pow(1 / marsDistAU, 3)

  const total = combined + planetaryBonus

  // Normalize to 0-100 index
  // Min tidal (neap + apogee + aphelion): ~0.85 relative units
  // Max tidal (perigean spring + perihelion): ~1.85 relative units
  const MIN = 0.85
  const MAX = 1.85
  const index = Math.max(0, Math.min(100, ((total - MIN) / (MAX - MIN)) * 100))

  const alignFactor = Math.abs(Math.cos(phaseRad))
  const tideType = alignFactor > 0.70 ? 'Spring'
                 : alignFactor < 0.30 ? 'Neap'
                 : 'Intermediate'

  return {
    moonTidal:     moonTidal.toFixed(4),
    sunTidal:      sunTidal.toFixed(4),
    combined:      total.toFixed(4),
    combinedIndex: index,
    type:          tideType,
    alignFactor:   alignFactor.toFixed(3)
  }
}

function calculateAlignmentScore(planets) {
  let score = 10

  // Jupiter near opposition or conjunction (elongation close to 0° or 180°)
  const jElong = planets.jupiter?.elongation ?? 90
  if (jElong < 20 || jElong > 160) score = Math.min(100, score + 25)

  // Saturn
  const sElong = planets.saturn?.elongation ?? 90
  if (sElong < 20 || sElong > 160) score = Math.min(100, score + 15)

  // Venus inferior conjunction (very close to Earth)
  const vElong = planets.venus?.elongation ?? 90
  if (vElong < 30) score = Math.min(100, score + 20)

  // Mars near opposition
  const mElong = planets.mars?.elongation ?? 90
  if (mElong > 160) score = Math.min(100, score + 10)

  return Math.round(score)
}

function phaseName(angle) {
  if (angle <  22.5 || angle >= 337.5) return 'New Moon'
  if (angle <  67.5) return 'Waxing Crescent'
  if (angle < 112.5) return 'First Quarter'
  if (angle < 157.5) return 'Waxing Gibbous'
  if (angle < 202.5) return 'Full Moon'
  if (angle < 247.5) return 'Waning Gibbous'
  if (angle < 292.5) return 'Last Quarter'
  return 'Waning Crescent'
}

function vecLen(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

module.exports = { getCurrentPlanetaryData }
