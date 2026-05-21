'use strict'

// Local quake database — JSON files organized by year-month
// data/quakes/YYYY-MM.json  →  array of quake objects
//
// The AI can query this via analyst:chat with context from getHistorySummary()

const path = require('path')
const fs   = require('fs')

const DB_DIR = path.join(__dirname, '..', 'data', 'quakes')

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

// ── Save ──────────────────────────────────────────────────────────────────────

function saveQuakes(quakes) {
  if (!quakes?.length) return { added: 0, months: [] }

  const byMonth = {}
  for (const q of quakes) {
    const key = q.time.slice(0, 7) // 'YYYY-MM'
    if (!byMonth[key]) byMonth[key] = []
    byMonth[key].push(q)
  }

  let totalAdded = 0
  const affectedMonths = []

  for (const [month, incoming] of Object.entries(byMonth)) {
    const file = path.join(DB_DIR, `${month}.json`)
    const existing = readMonth(month)

    const existingIds = new Set(existing.map(q => q.id))
    const newOnes = incoming.filter(q => !existingIds.has(q.id))

    if (newOnes.length === 0) continue

    const merged = [...existing, ...newOnes]
      .sort((a, b) => new Date(b.time) - new Date(a.time))

    fs.writeFileSync(file, JSON.stringify(merged))
    totalAdded += newOnes.length
    affectedMonths.push(month)
  }

  return { added: totalAdded, months: affectedMonths }
}

// ── Read ──────────────────────────────────────────────────────────────────────

function readMonth(month) {
  const file = path.join(DB_DIR, `${month}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

function queryRange(startDate, endDate, minMag = 0) {
  const start = new Date(startDate)
  const end   = new Date(endDate)

  const months = getMonthsInRange(start, end)
  let results  = []

  for (const m of months) {
    const quakes = readMonth(m)
    results.push(...quakes.filter(q => {
      const t = new Date(q.time)
      return t >= start && t <= end && q.mag >= minMag
    }))
  }

  return results.sort((a, b) => new Date(b.time) - new Date(a.time))
}

function listAvailableMonths() {
  try {
    return fs.readdirSync(DB_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function getMonthStats(month) {
  const quakes = readMonth(month)
  if (!quakes.length) return null

  const maxMag  = Math.max(...quakes.map(q => q.mag))
  const counts  = { '2-3': 0, '3-4': 0, '4-5': 0, '5-6': 0, '6-7': 0, '7+': 0 }
  for (const q of quakes) {
    if      (q.mag < 3) counts['2-3']++
    else if (q.mag < 4) counts['3-4']++
    else if (q.mag < 5) counts['4-5']++
    else if (q.mag < 6) counts['5-6']++
    else if (q.mag < 7) counts['6-7']++
    else                counts['7+']++
  }

  return {
    month,
    totalCount: quakes.length,
    maxMag,
    counts,
    tsunamiEvents: quakes.filter(q => q.tsunami).length,
    topRegions: topRegions(quakes, 5)
  }
}

// Build a summary string for Llama context injection
function getHistorySummary(months = 3) {
  const available = listAvailableMonths().slice(0, months)
  if (!available.length) return 'No local historical earthquake data available.'

  const lines = ['LOCAL QUAKE DATABASE SUMMARY (recent months):']
  for (const m of available) {
    const stats = getMonthStats(m)
    if (!stats) continue
    lines.push(
      `  ${m}: ${stats.totalCount} quakes, max M${stats.maxMag.toFixed(1)}, ` +
      `M6+: ${(stats.counts['6-7'] + stats.counts['7+']).toString()}, ` +
      `tsunami events: ${stats.tsunamiEvents}`
    )
  }
  return lines.join('\n')
}

function getDatabaseStats() {
  const months = listAvailableMonths()
  let total = 0
  for (const m of months) {
    const q = readMonth(m)
    total += q.length
  }
  return {
    totalRecords: total,
    monthsCovered: months.length,
    months: months.slice(0, 12)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMonthsInRange(start, end) {
  const months = []
  const cur = new Date(start.getFullYear(), start.getMonth(), 1)
  while (cur <= end) {
    const m = cur.toISOString().slice(0, 7)
    months.push(m)
    cur.setMonth(cur.getMonth() + 1)
  }
  return months
}

function topRegions(quakes, n) {
  const counts = {}
  for (const q of quakes) {
    const r = (q.place ?? 'Unknown').split(', ').pop()
    counts[r] = (counts[r] ?? 0) + 1
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }))
}

module.exports = {
  saveQuakes,
  readMonth,
  queryRange,
  listAvailableMonths,
  getMonthStats,
  getHistorySummary,
  getDatabaseStats
}
