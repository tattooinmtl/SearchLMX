'use strict'

const usgs      = require('./usgs')
const solar     = require('./solar')
const planetary = require('./planetary')
const algorithm = require('./algorithm')
const llama     = require('./llama-client')
const quakeDb   = require('./quake-db')

const DEFAULT_SYSTEM_PROMPT =
  'You are an expert seismic risk analyst. You analyze real-time earthquake data, ' +
  'solar activity, and planetary tidal forces to assess earthquake risk. ' +
  'Be concise, scientific, and always reference specific numbers from the data provided. ' +
  'Do not speculate beyond the data. Use plain prose — no markdown headers.'

async function runSimulation(opts = {}, onProgress = null, onToken = null) {
  const step = (msg, pct) => onProgress?.({ step: msg, pct })

  step('Fetching earthquake data from USGS + EMSC...', 10)
  const [quakeData, solarData] = await Promise.all([
    usgs.fetchRecentQuakes(opts.hours ?? 24, opts.minMag ?? 2.5),
    solar.fetchAllSolarData()
  ])

  step('Calculating planetary positions and tidal forces...', 40)
  const planetaryData = planetary.getCurrentPlanetaryData()

  step('Running seismic risk algorithm...', 60)
  const riskResult = algorithm.runRiskAlgorithm(quakeData, solarData, planetaryData)

  let llamaAnalysis = null
  let llamaAvailable = false

  step('Checking Llama server...', 75)
  llamaAvailable = await llama.checkHealth()

  if (llamaAvailable) {
    step('Streaming Llama AI analysis...', 80)
    try {
      const historySummary = quakeDb.getHistorySummary(3)
      const userPrompt   = buildPrompt(quakeData, solarData, planetaryData, riskResult, historySummary)
      const systemPrompt = opts.systemPrompt || DEFAULT_SYSTEM_PROMPT
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ]
      const sampling = {
        temperature:   opts.temperature,
        topP:          opts.topP,
        topK:          opts.topK,
        repeatPenalty: opts.repeatPenalty,
        maxTokens:     opts.maxTokens,
        mirostat:      opts.mirostat,
        mirostatTau:   opts.mirostatTau,
        mirostatEta:   opts.mirostatEta
      }
      llamaAnalysis = await llama.streamAnalyze(messages, opts.port ?? 8080, onToken, sampling)
    } catch (e) {
      llamaAnalysis = `[Analysis error: ${e.message}]`
    }
  }

  step('Simulation complete.', 100)

  return {
    timestamp: new Date().toISOString(),
    quakeData,
    solarData,
    planetaryData,
    riskResult,
    llamaAnalysis,
    llamaAvailable
  }
}

function buildPrompt(quakeData, solarData, planetaryData, risk, historySummary = '') {
  const q  = quakeData?.pattern  ?? {}
  const xr = solarData?.xrayFlux ?? {}
  const kp = solarData?.kpIndex  ?? {}
  const sw = solarData?.solarWind ?? {}
  const mn = planetaryData?.moon  ?? {}
  const td = planetaryData?.tidal ?? {}

  const significantFlares = (solarData?.flares ?? [])
    .filter(f => ['M', 'X'].includes((f.classType ?? '')[0]))
    .slice(0, 5)
    .map(f => `${f.classType} (${f.beginTime})`)
    .join(', ') || 'None in last 7 days'

  const topRegions = (risk.regions ?? []).slice(0, 5)
    .map(r => `  ${r.region}: ${r.score}/100 [${r.level}], ${r.quakeCount} quakes, max M${r.maxMag}`)
    .join('\n')

  return `GEOPHYSICAL DATA — ${new Date().toUTCString()}

SEISMIC ACTIVITY (last 24h):
  Total M2.5+: ${q.totalCount ?? 0}
  Max magnitude: M${(q.maxMag ?? 0).toFixed(1)}
  Tsunami alerts: ${q.tsunamiAlerts ?? 0}
  Hot regions: ${(q.activeRegions ?? []).slice(0, 5).map(r => r.name).join(', ') || 'none'}

SOLAR CONDITIONS:
  X-ray class: ${xr.label ?? 'A0.0'}
  Solar wind: ${sw.speed ?? 'N/A'} km/s, density ${sw.density ?? 'N/A'} p/cm3
  IMF Bz: ${sw.bz ?? 'N/A'} nT, Bt: ${sw.bt ?? 'N/A'} nT
  Kp index: ${Number.isFinite(kp.current) ? kp.current.toFixed(1) : 'N/A'} (${kp.stormLevel ?? 'Quiet'})
  Active solar regions: ${(solarData?.activeRegions ?? []).length}
  Significant flares (7d): ${significantFlares}

TIDAL / PLANETARY:
  Moon: ${mn.phaseName ?? 'N/A'}, ${Number.isFinite(mn.illumination) ? mn.illumination.toFixed(0) : '?'}% lit, ${mn.distanceKm ? mn.distanceKm.toLocaleString() : '?'} km${mn.isPerigee ? ' [PERIGEE]' : ''}
  Sun: ${planetaryData?.sun?.distanceAU?.toFixed(4) ?? 'N/A'} AU${planetaryData?.sun?.isNearPerihelion ? ' [PERIHELION]' : ''}
  Tide type: ${td.type ?? 'N/A'}, stress index: ${Number.isFinite(parseFloat(td.combinedIndex)) ? parseFloat(td.combinedIndex).toFixed(1) : 'N/A'}/100
  Planetary alignment score: ${planetaryData?.alignmentScore ?? 'N/A'}/100

RISK ALGORITHM OUTPUT:
  Overall: ${risk.overall?.score ?? 'N/A'}/100 — ${risk.overall?.level ?? 'N/A'}
  Tidal: ${risk.factors?.tidal ?? '?'} | Solar: ${risk.factors?.solar ?? '?'} | Geomagnetic: ${risk.factors?.geomagnetic ?? '?'} | Historical: ${risk.factors?.historical ?? '?'} | Planetary: ${risk.factors?.planetary ?? '?'}

TOP RISK REGIONS:
${topRegions || '  No data'}

${historySummary ? historySummary + '\n\n' : ''}Provide a structured risk assessment:
1. GLOBAL OUTLOOK (2-3 sentences): Overall seismic risk for next 24-48h citing the main drivers.
2. WATCH ZONES: The 3 most concerning regions with specific reasoning from the data.
3. KEY DRIVERS: Which specific data values are most significant today.
4. CONFIDENCE: Your confidence level and main uncertainties.`
}

module.exports = { runSimulation, buildPrompt, DEFAULT_SYSTEM_PROMPT }
