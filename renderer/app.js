'use strict'
/* global L, Chart, QE */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  quakeData:    null,
  solarData:    null,
  planetaryData:null,
  lastSimResult:null,
  llamaRunning: false,
  map:          null,
  quakeLayer:   null,
  charts:       {},
  chatHistory:  [],   // [{role, content}] conversation with context
  personality:  null,
  skills:       [],
  generating:   false,
  genStartTime: 0,
  genTokenCount:0,
  genInterval:  null,
  abortGen:     false
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setInitMsg('Initializing map...')
  initMap()

  setInitMsg('Setting up UI...')
  setupNav()
  setupWindowControls()
  setupButtons()
  setupIpcListeners()
  setupMagSlider()

  setInitMsg('Loading personality & skills...')
  await Promise.all([loadPersonality(), loadSkills()])

  setInitMsg('Loading available models...')
  await loadModels()

  setInitMsg('Checking Llama server...')
  await refreshServerStatus()

  setInitMsg('Fetching live data...')
  await Promise.allSettled([
    refreshDashboard(),
    refreshSolarData(),
    refreshPlanetaryData()
  ])

  setInitMsg('Ready.')
  await new Promise(r => setTimeout(r, 350))
  document.getElementById('init-overlay').style.display = 'none'
}

function setInitMsg(msg) { document.getElementById('init-msg').textContent = msg }

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById('panel-' + btn.dataset.panel).classList.add('active')

      if (btn.dataset.panel === 'solar')    { if (!state.solarData) refreshSolarData(); else renderSolarCharts() }
      if (btn.dataset.panel === 'quakefeed') refreshQuakeFeed()
      if (btn.dataset.panel === 'planetary') renderMagDistChart()
      if (btn.dataset.panel === 'history')   loadHistory()
      if (btn.dataset.panel === 'database')  loadDbPanel()
      if (btn.dataset.panel === 'stats')     loadStatsPanel()
      if (btn.dataset.panel === 'qnews')       loadQuakeNews()
      if (btn.dataset.panel === 'stations')    initStationsPanel()
      if (btn.dataset.panel === 'appsettings') openSettings('model')
      if (btn.dataset.panel === 'dashboard' && state.map) {
        setTimeout(() => state.map.invalidateSize(), 50)
      }
    })
  })
}

function setupWindowControls() {
  document.getElementById('btn-min').addEventListener('click',   () => QE.minimize())
  document.getElementById('btn-max').addEventListener('click',   () => QE.maximize())
  document.getElementById('btn-close').addEventListener('click', () => QE.close())
}

// ── Buttons ───────────────────────────────────────────────────────────────────
function setupButtons() {
  document.getElementById('btn-refresh-dash').addEventListener('click',    refreshDashboard)
  document.getElementById('btn-refresh-feed').addEventListener('click',    refreshQuakeFeed)
  document.getElementById('btn-refresh-solar').addEventListener('click',   refreshSolarData)
  document.getElementById('btn-refresh-planet').addEventListener('click',  refreshPlanetaryData)
  document.getElementById('btn-refresh-history').addEventListener('click', loadHistory)
  document.getElementById('btn-db-refresh').addEventListener('click',      loadDbPanel)
  document.getElementById('btn-db-query').addEventListener('click',        queryDb)
  document.getElementById('btn-toggle-server').addEventListener('click',   toggleServer)
  document.getElementById('btn-run-sim').addEventListener('click',         runSimulation)
  document.getElementById('btn-save-sim').addEventListener('click',        saveSimResult)
  document.getElementById('btn-reload-model').addEventListener('click',    reloadModelServer)
  document.getElementById('btn-save-personality').addEventListener('click',savePersonality)
  document.getElementById('btn-save-skills').addEventListener('click',     saveSkillsList)
  document.getElementById('btn-add-skill').addEventListener('click',       addCustomSkill)
  document.getElementById('btn-chat-send').addEventListener('click',       sendChat)
  document.getElementById('btn-stop-gen').addEventListener('click',        stopGeneration)
  document.getElementById('btn-sidebar-load-model').addEventListener('click', sidebarLoadModel)
  document.getElementById('btn-refresh-stats').addEventListener('click',   loadStatsPanel)
  document.getElementById('btn-refresh-qnews').addEventListener('click',   loadQuakeNews)
  document.getElementById('btn-settings-load-model').addEventListener('click', settingsLoadModel)

  // Settings tab switcher
  document.querySelectorAll('.stab').forEach(tab => {
    tab.addEventListener('click', () => openSettings(tab.dataset.stab))
  })

  // Stats filters auto-refresh
  document.getElementById('stats-hours').addEventListener('change',   loadStatsPanel)
  document.getElementById('stats-minmag').addEventListener('change',  loadStatsPanel)

  // Quake News filters
  document.getElementById('qnews-hours').addEventListener('change',   () => {})  // manual scan only


  // Quake feed
  document.getElementById('btn-refresh-feed').addEventListener('click', refreshQuakeFeed)
  document.getElementById('qf-minmag').addEventListener('change', refreshQuakeFeed)
  document.getElementById('qf-hours').addEventListener('change', refreshQuakeFeed)

  // Dashboard range change → re-fetch
  document.getElementById('dash-hours').addEventListener('change', refreshDashboard)

  // Model change hint
  document.getElementById('sim-model').addEventListener('change', () => {
    document.getElementById('btn-reload-model').style.display = ''
    document.getElementById('model-reload-hint').style.display = ''
  })

  // Chat enter key
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
  })

  // Mirostat toggle
  document.getElementById('cfg-mirostat').addEventListener('change', e => {
    document.getElementById('mirostat-opts').style.display = e.target.checked ? '' : 'none'
  })

  // Range sliders live update
  const ranges = [
    ['cfg-temp', 'cfg-temp-val', v => (+v).toFixed(2)],
    ['cfg-topp', 'cfg-topp-val', v => (+v).toFixed(2)],
    ['cfg-topk', 'cfg-topk-val', v => v],
    ['cfg-rep',  'cfg-rep-val',  v => (+v).toFixed(2)],
    ['cfg-maxt', 'cfg-maxt-val', v => v],
    ['cfg-tau',  'cfg-tau-val',  v => (+v).toFixed(1)],
    ['cfg-eta',  'cfg-eta-val',  v => (+v).toFixed(2)]
  ]
  for (const [id, valId, fmt] of ranges) {
    const el = document.getElementById(id)
    if (el) el.addEventListener('input', () => set(valId, fmt(el.value)))
  }
}

// ── IPC listeners ─────────────────────────────────────────────────────────────
function setupIpcListeners() {
  QE.on('simulation:progress', ({ step, pct }) => {
    document.getElementById('sim-progress-bar').style.width = pct + '%'
    document.getElementById('sim-progress-text').textContent = step
  })

  QE.on('llama:startProgress', ({ step }) => setServerStatus('loading', step))

  QE.on('llama:token', (token) => {
    if (state.abortGen) return
    appendStreamToken(token)
    updateTokenStats()
  })
}

// ── Streaming helpers ─────────────────────────────────────────────────────────
let streamTarget = null // DOM element to append tokens to
let streamBuffer = ''

function startStreaming(el) {
  streamTarget = el
  streamBuffer = ''
  state.generating = true
  state.abortGen   = false
  state.genStartTime   = Date.now()
  state.genTokenCount  = 0
  document.getElementById('token-stats-bar').style.display = ''
  state.genInterval = setInterval(updateTokenStats, 500)
}

function stopStreaming() {
  state.generating = false
  clearInterval(state.genInterval)
  document.getElementById('token-stats-bar').style.display = 'none'
  streamTarget = null
}

function appendStreamToken(token) {
  state.genTokenCount++
  streamBuffer += token
  if (streamTarget) streamTarget.textContent = streamBuffer
}

function updateTokenStats() {
  const elapsed = (Date.now() - state.genStartTime) / 1000
  const tps = elapsed > 0 ? (state.genTokenCount / elapsed).toFixed(1) : '0'
  set('ts-tps',     tps + ' t/s')
  set('ts-tokens',  state.genTokenCount + ' tokens')
  set('ts-elapsed', elapsed.toFixed(1) + 's')
}

function stopGeneration() {
  state.abortGen = true
  stopStreaming()
}

// ── Magnitude slider ──────────────────────────────────────────────────────────
function setupMagSlider() {
  const slider = document.getElementById('dash-mag-slider')
  const label  = document.getElementById('dash-mag-val')
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value).toFixed(1)
    label.textContent = v
    if (state.quakeData?.quakes) {
      const filtered = state.quakeData.quakes.filter(q => q.mag >= parseFloat(slider.value))
      updateMap(filtered)
    }
  })
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
  state.map = L.map('quake-map', { center: [20, 0], zoom: 2, attributionControl: false })
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 19 }).addTo(state.map)
  state.quakeLayer = L.layerGroup().addTo(state.map)
}

function updateMap(quakes) {
  if (!state.quakeLayer) return
  state.quakeLayer.clearLayers()
  for (const q of (quakes ?? [])) {
    const color  = magColor(q.mag)
    const radius = Math.max(3, Math.pow(q.mag, 1.8))
    L.circleMarker([q.lat, q.lon], {
      radius, fillColor: color, color: 'rgba(0,0,0,0.3)',
      weight: 1, opacity: 0.9, fillOpacity: 0.72
    })
    .bindPopup(`
      <div class="popup-mag" style="color:${color}">M${q.mag.toFixed(1)}</div>
      <div class="popup-place">${q.place ?? 'Unknown'}</div>
      <div class="popup-meta">
        Depth: ${(q.depth ?? 0).toFixed(1)} km<br>
        ${new Date(q.time).toUTCString()}
        ${q.tsunami ? '<br><b style="color:#f87171">TSUNAMI ALERT</b>' : ''}
      </div>
    `)
    .addTo(state.quakeLayer)
  }
}

function magColor(mag) {
  if (mag >= 7.0) return '#9333ea'
  if (mag >= 6.0) return '#ef4444'
  if (mag >= 5.0) return '#f97316'
  if (mag >= 4.0) return '#f59e0b'
  if (mag >= 3.0) return '#a3e635'
  return '#60a5fa'
}
function magClass(mag) {
  if (mag >= 7) return 'm7'
  if (mag >= 6) return 'm6'
  if (mag >= 5) return 'm5'
  if (mag >= 4) return 'm4'
  if (mag >= 3) return 'm3'
  return 'm2'
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function refreshDashboard() {
  const hours  = +document.getElementById('dash-hours').value
  const minMag = 0.1 // fetch all, slider filters display
  const data   = await QE.getQuakeData({ hours, minMag })
  if (data?.error) return
  state.quakeData = data

  set('s-quakes',     safeNum(data.pattern?.totalCount, '--'))
  set('s-quakes-sub', `M${minMag}+ global, last ${hours}h`)
  const mm = data.pattern?.maxMag
  set('s-maxmag', (mm != null && Number.isFinite(mm) && mm > 0) ? 'M' + mm.toFixed(1) : '--')
  set('dash-updated', 'Updated ' + timeAgo(new Date()))

  // Apply current slider filter to map
  const slider  = document.getElementById('dash-mag-slider')
  const minShow = parseFloat(slider.value)
  const filtered = data.quakes.filter(q => q.mag >= minShow)
  updateMap(filtered)
  renderRecentList(data.quakes)
}

// ── Quake Feed ────────────────────────────────────────────────────────────────
async function refreshQuakeFeed() {
  const minMag  = +document.getElementById('qf-minmag').value
  const hours   = +document.getElementById('qf-hours').value
  const loading = document.getElementById('qf-loading')
  const empty   = document.getElementById('qf-empty')
  const table   = document.getElementById('quake-table')
  if (loading) loading.style.display = ''
  if (empty)   empty.style.display = 'none'
  if (table)   table.style.display = 'none'
  set('qf-count', '')

  const data = await QE.getQuakeData({ hours, minMag })
  if (loading) loading.style.display = 'none'

  if (!data?.quakes?.length) {
    if (empty) empty.style.display = ''
    set('qf-count', data?.error ? 'Error: ' + data.error.slice(0, 50) : '')
    return
  }

  if (table) table.style.display = ''
  set('qf-count', data.quakes.length + ' events')
  renderQuakeTable(data.quakes)
}

function renderRecentList(quakes) {
  const list = document.getElementById('recent-quakes-list')
  list.innerHTML = [...quakes]
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 30)
    .map(q => `
      <div class="quake-item">
        <span class="qi-mag ${magClass(q.mag)}">M${q.mag.toFixed(1)}</span>
        <span class="qi-place">${q.place ?? 'Unknown'}${q.tsunami ? '<span class="qi-tsunami">TSUNAMI</span>' : ''}</span>
        <div class="qi-meta">${timeAgo(new Date(q.time))} &middot; ${(q.depth ?? 0).toFixed(0)} km depth</div>
      </div>`).join('')
}

function renderQuakeTable(quakes) {
  document.getElementById('quake-tbody').innerHTML = quakes.map(q => `
    <tr>
      <td class="mag-cell" style="color:${magColor(q.mag)}">M${q.mag.toFixed(1)}</td>
      <td>${q.place ?? 'Unknown'}</td>
      <td style="font-family:var(--mono)">${(q.depth ?? 0).toFixed(1)}</td>
      <td style="font-family:var(--mono);font-size:11px">${new Date(q.time).toISOString().replace('T',' ').slice(0,19)}</td>
      <td style="color:${q.tsunami ? 'var(--high)' : 'var(--text-dim)'}">${q.tsunami ? 'YES' : '--'}</td>
      <td style="font-size:10px;color:var(--text-dim)">${q.source ?? 'USGS'}</td>
    </tr>`).join('')
}

// ── Solar ─────────────────────────────────────────────────────────────────────
async function refreshSolarData() {
  set('solar-updated', 'Loading...')
  const data = await QE.getSolarData()
  if (!data || data.error) {
    set('solar-updated', 'Error fetching solar data')
    return
  }
  state.solarData = data
  const xr = data.xrayFlux, kp = data.kpIndex, sw = data.solarWind

  // Dashboard summary cards
  set('s-solar',    xr?.label ?? '--')
  set('s-kp',       Number.isFinite(kp?.current) ? kp.current.toFixed(1) : '--')
  set('s-kp-storm', kp?.stormLevel ?? '--')

  // Solar panel detail cards
  set('sol-class',   xr?.label ?? '--')
  set('sol-flux',    (xr?.current && Number.isFinite(xr.current)) ? xr.current.toExponential(2) + ' W/m²' : '--')
  set('sol-kp',      Number.isFinite(kp?.current) ? kp.current.toFixed(1) : '--')
  set('sol-storm',   kp?.stormLevel ?? '--')
  set('sol-wind',    Number.isFinite(sw?.speed)   ? sw.speed.toFixed(0)   : '--')
  set('sol-bz',      Number.isFinite(sw?.bz)      ? sw.bz.toFixed(1)      : '--')
  set('sol-bt',      Number.isFinite(sw?.bt)       ? sw.bt.toFixed(1)      : '--')
  set('sol-density', Number.isFinite(sw?.density)  ? sw.density.toFixed(1) : '--')
  set('sol-regions', data.activeRegions?.length ?? '--')

  const mxFlares = (data.flares ?? []).filter(f => ['M','X'].includes((f.classType??'')[0]))
  set('sol-flares', mxFlares.length)

  set('solar-updated', 'Updated ' + timeAgo(new Date()))

  renderActiveRegions(data.activeRegions ?? [])
  renderRecentFlares(mxFlares)

  if (document.getElementById('panel-solar').classList.contains('active')) renderSolarCharts()
}

function renderActiveRegions(regions) {
  const el = document.getElementById('sol-active-regions-table')
  if (!el) return
  if (!regions.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No active sunspot regions</div>'; return }
  el.innerHTML = `<table style="width:100%;font-size:11px;border-collapse:collapse">
    <thead><tr style="color:var(--text-dim)">
      <th style="text-align:left;padding:3px 6px">Region</th>
      <th>Location</th><th>Class</th><th>C</th><th>M</th><th>X</th>
    </tr></thead>
    <tbody>${regions.map(r => `<tr style="border-top:1px solid var(--surface3)">
      <td style="padding:3px 6px;font-family:var(--mono);color:var(--accent)">${r.region}</td>
      <td style="padding:3px 6px">${r.location}</td>
      <td style="padding:3px 6px">${r.classZ}</td>
      <td style="padding:3px 6px;color:var(--moderate)">${r.cFlares || '--'}</td>
      <td style="padding:3px 6px;color:var(--elevated)">${r.mFlares || '--'}</td>
      <td style="padding:3px 6px;color:var(--high)">${r.xFlares || '--'}</td>
    </tr>`).join('')}</tbody>
  </table>`
}

function renderRecentFlares(flares) {
  const el = document.getElementById('sol-flares-list')
  if (!el) return
  if (!flares.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No M/X flares in the last 7 days</div>'; return }
  el.innerHTML = flares.slice(0, 8).map(f => {
    const cls = (f.classType ?? 'A')[0]
    const color = cls === 'X' ? 'var(--high)' : 'var(--elevated)'
    return `<div style="display:flex;align-items:center;gap:10px;padding:4px 0;border-bottom:1px solid var(--surface3);font-size:11px">
      <span style="font-family:var(--mono);font-weight:700;color:${color};min-width:40px">${f.classType}</span>
      <span style="color:var(--text-muted)">${f.beginTime?.slice(0,16)?.replace('T',' ') ?? '--'}</span>
      <span style="color:var(--text-dim);margin-left:auto">Region ${f.region}</span>
    </div>`
  }).join('')
}

function renderSolarCharts() {
  if (!state.solarData) return
  const { xrayFlux, kpIndex, solarWind } = state.solarData

  if (xrayFlux?.timeSeries?.length) {
    const ts = xrayFlux.timeSeries
    rebuildChart('xray', 'chart-xray', {
      type: 'line',
      data: { labels: ts.map(d => d.time?.slice(11,16) ?? ''),
        datasets: [{ label: 'Log₁₀ X-ray Flux', data: ts.map(d => d.flux > 0 ? Math.log10(d.flux) : -9),
          borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)',
          borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.3 }] },
      options: chartOpts('Log₁₀(W/m²)', { suggestedMin: -9, suggestedMax: -3 })
    })
  }

  if (kpIndex?.timeSeries?.length) {
    const rows = kpIndex.timeSeries.slice(-16)
    rebuildChart('kp', 'chart-kp', {
      type: 'bar',
      data: { labels: rows.map(r => (r.time ?? '').slice(5,16).replace('T',' ')),
        datasets: [{ label: 'Kp', data: rows.map(r => r.kp),
          backgroundColor: rows.map(r => kpBarColor(r.kp)), borderRadius: 3 }] },
      options: chartOpts('Kp', { min: 0, max: 9 })
    })
  }

  if (solarWind?.timeSeries?.length) {
    const rows = solarWind.timeSeries.slice(-60)
    rebuildChart('wind', 'chart-wind', {
      type: 'line',
      data: { labels: rows.map(r => (r.time ?? '').slice(11,16)),
        datasets: [{ label: 'Speed km/s', data: rows.map(r => Number.isFinite(r.speed) ? r.speed : null),
          borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.08)',
          borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.3,
          spanGaps: true }] },
      options: chartOpts('km/s')
    })
  }
}

function kpBarColor(kp) {
  if (kp >= 7) return '#ef4444'; if (kp >= 5) return '#f97316'
  if (kp >= 3) return '#f59e0b'; return '#22c55e'
}

// ── Planetary ─────────────────────────────────────────────────────────────────
async function refreshPlanetaryData() {
  const data = await QE.getPlanetaryData()
  if (data?.error) return
  state.planetaryData = data
  const mn = data.moon ?? {}, sn = data.sun ?? {}, td = data.tidal ?? {}
  const ti = parseFloat(td.combinedIndex) || 0
  set('s-tidal', ti.toFixed(0))
  set('s-tidal-type', td.type ?? '--')
  set('tidal-index-val', ti.toFixed(1) + ' / 100')
  set('tidal-type-label', td.type ?? '--')
  document.getElementById('tidal-gauge-bar').style.width = ti + '%'
  set('p-moon-phase', mn.phaseName ?? '--')
  set('p-moon-illum', Number.isFinite(mn.illumination) ? mn.illumination.toFixed(0) + '%' : '--')
  set('p-moon-dist',  mn.distanceKm ? mn.distanceKm.toLocaleString() + ' km' : '--')
  set('p-moon-tidal', td.moonTidal ? parseFloat(td.moonTidal).toFixed(3) + 'x' : '--')
  set('p-sun-dist',  sn.distanceAU ? sn.distanceAU.toFixed(4) + ' AU' : '--')
  set('p-sun-tidal', td.sunTidal ? parseFloat(td.sunTidal).toFixed(4) + 'x' : '--')
  set('p-sun-peri',  sn.isNearPerihelion ? 'YES' : 'No')
  set('p-sun-align', td.type === 'Spring' ? 'Spring tide alignment' : (td.type ?? '--') + ' tide')
  for (const [id, key] of [['jup','jupiter'],['sat','saturn'],['ven','venus'],['mars','mars']]) {
    const p = data[key] ?? {}
    set(`p-${id}-dist`,  p.distanceAU ? p.distanceAU.toFixed(3) + ' AU' : '--')
    set(`p-${id}-elong`, p.elongation != null ? p.elongation.toFixed(1) + '°' : '--')
  }
  set('planet-updated', 'Updated ' + timeAgo(new Date()))
  renderMagDistChart()
}

function renderMagDistChart() {
  if (!state.quakeData?.pattern?.magBuckets) return
  const bk = state.quakeData.pattern.magBuckets
  rebuildChart('magdist', 'chart-magdist', {
    type: 'bar',
    data: { labels: Object.keys(bk), datasets: [{ label: 'Count', data: Object.values(bk),
      backgroundColor: ['#60a5fa','#a3e635','#f59e0b','#f97316','#ef4444','#dc2626'], borderRadius: 4 }] },
    options: { ...chartOpts('Count'), plugins: { legend: { display: false } } }
  })
}

// ── Database panel ────────────────────────────────────────────────────────────
async function loadDbPanel() {
  const stats  = await QE.dbStats()
  const months = await QE.dbMonths()
  set('db-total',        stats?.totalRecords ?? '--')
  set('db-months-count', stats?.monthsCovered ?? '--')

  const btns = document.getElementById('db-month-buttons')
  btns.innerHTML = months.map(m =>
    `<button class="month-btn" data-month="${m}">${m}</button>`
  ).join('')

  btns.querySelectorAll('.month-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btns.querySelectorAll('.month-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      const ms = await QE.dbMonth(btn.dataset.month)
      renderMonthDetail(ms)
    })
  })
}

function renderMonthDetail(stats) {
  if (!stats) return
  const el = document.getElementById('db-month-detail')
  el.style.display = ''
  document.getElementById('db-month-content').innerHTML = `
    <div class="rs-title">${stats.month}</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:8px 0">
      <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value" style="font-size:18px">${stats.totalCount}</div></div>
      <div class="stat-card"><div class="stat-label">Max Mag</div><div class="stat-value" style="font-size:18px">M${stats.maxMag?.toFixed(1) ?? '--'}</div></div>
      <div class="stat-card"><div class="stat-label">M6+</div><div class="stat-value" style="font-size:18px">${(stats.counts?.['6-7'] ?? 0) + (stats.counts?.['7+'] ?? 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Tsunami</div><div class="stat-value" style="font-size:18px">${stats.tsunamiEvents ?? 0}</div></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted)">
      Breakdown: ${Object.entries(stats.counts ?? {}).map(([k,v]) => `M${k}: ${v}`).join(' | ')}
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
      Top regions: ${(stats.topRegions ?? []).slice(0,5).map(r => `${r.name} (${r.count})`).join(', ') || 'N/A'}
    </div>`
}

async function queryDb() {
  const start  = document.getElementById('db-start').value
  const end    = document.getElementById('db-end').value
  const minMag = parseFloat(document.getElementById('db-minmag').value) || 0
  if (!start || !end) { document.getElementById('db-query-result').textContent = 'Set start and end dates.'; return }
  const res = await QE.dbQuery(start + 'T00:00:00Z', end + 'T23:59:59Z', minMag)
  const el  = document.getElementById('db-query-result')
  if (!res?.length) { el.textContent = 'No results in that range.'; return }
  const maxMag = Math.max(...res.map(q => q.mag))
  el.innerHTML = `Found ${res.length} earthquakes M${minMag}+ from ${start} to ${end}. Max: M${maxMag.toFixed(1)}. <br>` +
    res.slice(0, 8).map(q => `M${q.mag.toFixed(1)} — ${q.place ?? 'Unknown'} — ${new Date(q.time).toUTCString()}`).join('<br>') +
    (res.length > 8 ? `<br>... and ${res.length - 8} more.` : '')
}

// ── Server management ─────────────────────────────────────────────────────────
async function refreshServerStatus() {
  const { running } = await QE.llamaStatus()
  state.llamaRunning = running
  setServerStatus(running ? 'online' : 'offline', running ? 'Online' : 'Offline')
  document.getElementById('btn-toggle-server').textContent = running ? 'Restart Server' : 'Start Server'
}

async function toggleServer() {
  const btn = document.getElementById('btn-toggle-server')
  btn.disabled = true; btn.textContent = 'Starting...'
  setServerStatus('loading', 'Loading model...')
  const result = await QE.startLlama({ model: getSelectedModelPath() })
  if (result?.error) {
    setServerStatus('offline', 'Failed: ' + result.error.slice(0, 40))
    btn.disabled = false; btn.textContent = 'Retry'
    return
  }
  await refreshServerStatus()
  btn.disabled = false
}

async function reloadModelServer() {
  const btn = document.getElementById('btn-reload-model')
  btn.disabled = true; btn.textContent = 'Reloading...'
  setServerStatus('loading', 'Reloading model...')
  const result = await QE.startLlama({ model: getSelectedModelPath() })
  if (!result?.error) {
    document.getElementById('btn-reload-model').style.display = 'none'
    document.getElementById('model-reload-hint').style.display = 'none'
    await refreshServerStatus()
  } else {
    setServerStatus('offline', 'Failed: ' + result.error.slice(0, 40))
  }
  btn.disabled = false; btn.textContent = '&#8635; Reload Server with this Model'
}

function setServerStatus(statusClass, text) {
  document.getElementById('server-status-dot').className = statusClass
  set('server-status-text', text.slice(0, 60))
}

async function loadModels() {
  const models = await QE.listModels()
  const opts = models.map((m, i) =>
    `<option value="${m.path}" ${i === 0 ? 'selected' : ''}>${m.name}</option>`
  ).join('')

  const simSel      = document.getElementById('sim-model')
  const sidebarSel  = document.getElementById('sidebar-model-select')
  const settingsSel = document.getElementById('settings-model-select')
  if (simSel)      simSel.innerHTML      = opts
  if (sidebarSel)  sidebarSel.innerHTML  = opts || '<option value="">No models found in Models/</option>'
  if (settingsSel) settingsSel.innerHTML = opts || '<option value="">No models found in Models/</option>'

  if (models[0]) set('server-model-name', models[0].name.replace('.gguf', ''))
}

function getSelectedModelPath() {
  // Prefer sidebar selection since it's always visible
  return document.getElementById('sidebar-model-select')?.value ||
         document.getElementById('sim-model')?.value || null
}

async function sidebarLoadModel() {
  const path = document.getElementById('sidebar-model-select')?.value
  if (!path) return
  const btn = document.getElementById('btn-sidebar-load-model')
  btn.disabled = true
  btn.textContent = 'Loading...'
  setServerStatus('loading', 'Loading model...')

  const modelName = path.split(/[\\/]/).pop().replace('.gguf', '')
  const result = await QE.startLlama({ model: path })

  if (result?.error) {
    setServerStatus('offline', 'Failed — check model file')
    btn.disabled = false
    btn.textContent = '&#9654; Load Model'
    return
  }

  set('server-model-name', modelName)
  // Sync the sim panel dropdown to match
  const simSel = document.getElementById('sim-model')
  if (simSel) simSel.value = path

  await refreshServerStatus()
  btn.disabled = false
  btn.textContent = '&#9654; Load Model'
}

// ── Settings panel ────────────────────────────────────────────────────────────
const CATALOG = [
  {
    id: 'llama32-1b',
    name: 'Llama 3.2 1B Instruct',
    filename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    size: '0.8 GB',
    tag: 'fast',
    desc: 'Ultra-fast, very low RAM. Good for quick summaries. Best if your CPU is slow.',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf'
  },
  {
    id: 'llama32-3b',
    name: 'Llama 3.2 3B Instruct',
    filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    size: '2.0 GB',
    tag: 'fast',
    desc: 'Default model. Great CPU performance with solid analysis quality.',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf'
  },
  {
    id: 'phi35-mini',
    name: 'Phi-3.5 Mini Instruct (3.8B)',
    filename: 'Phi-3.5-mini-instruct-Q4_K_M.gguf',
    size: '2.2 GB',
    tag: 'smart',
    desc: 'Microsoft\'s efficient model — punches above its weight on reasoning and technical analysis.',
    url: 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf'
  },
  {
    id: 'gemma2-2b',
    name: 'Gemma 2 2B Instruct',
    filename: 'gemma-2-2b-it-Q4_K_M.gguf',
    size: '1.6 GB',
    tag: 'fast',
    desc: 'Google\'s compact model. Surprisingly capable for its size, fast on CPU.',
    url: 'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf'
  },
  {
    id: 'mistral-7b',
    name: 'Mistral 7B Instruct v0.3',
    filename: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    size: '4.1 GB',
    tag: 'smart',
    desc: 'Classic benchmark beater. Excellent seismic analysis depth. Needs 8+ GB RAM.',
    url: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf'
  },
  {
    id: 'qwen25-7b',
    name: 'Qwen 2.5 7B Instruct',
    filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    size: '4.1 GB',
    tag: 'smart',
    desc: 'Alibaba\'s 2025 model. Strong at structured output, statistics, and technical reasoning.',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf'
  },
  {
    id: 'deepseek-r1-7b',
    name: 'DeepSeek R1 Distill 7B (Qwen)',
    filename: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',
    size: '4.3 GB',
    tag: 'smart',
    desc: 'Chain-of-thought reasoning model. Best for complex multi-factor seismic analysis. Needs 8+ GB RAM.',
    url: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf'
  },
  {
    id: 'llama31-8b',
    name: 'Llama 3.1 8B Instruct',
    filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    size: '4.9 GB',
    tag: 'large',
    desc: 'Meta\'s flagship 8B. Best overall quality. Use ctx 2048 to keep RAM under 10 GB.',
    url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'
  }
]

const activeDownloads = {}

function openSettings(tab = 'model') {
  document.querySelectorAll('.stab').forEach(t => t.classList.toggle('active', t.dataset.stab === tab))
  document.querySelectorAll('.stab-panel').forEach(p => {
    const isActive = p.id === 'stab-' + tab
    p.classList.toggle('active', isActive)
    // Override inline padding style to force display via class
    p.style.setProperty('display', isActive ? 'flex' : 'none', 'important')
  })

  // Show correct save button
  document.getElementById('btn-save-personality').style.display = tab === 'profile' ? '' : 'none'
  document.getElementById('btn-save-skills').style.display     = tab === 'skills'  ? '' : 'none'

  if (tab === 'model')    renderInstalledModels()
  if (tab === 'download') renderModelCatalog()
  if (tab === 'skills')   renderSkillsList()
  if (tab === 'profile')  renderPersonalityForm()
}

async function renderInstalledModels() {
  const models  = await QE.listModels()
  const current = document.getElementById('sidebar-model-select')?.value ?? ''
  const list    = document.getElementById('settings-model-list')
  const sel     = document.getElementById('settings-model-select')

  if (!list) return

  const opts = models.map((m, i) =>
    `<option value="${m.path}" ${i === 0 ? 'selected' : ''}>${m.name}</option>`
  ).join('')
  if (sel) sel.innerHTML = opts || '<option value="">No models in Models/</option>'

  if (models.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px">No models found in Models/ folder. Download one below.</div>'
    return
  }

  list.innerHTML = models.map(m => {
    const isActive = m.path === current
    return `<div class="installed-model-row ${isActive ? 'active-model' : ''}">
      <span class="imr-name">${m.name}</span>
      ${isActive ? '<span class="imr-active">● ACTIVE</span>' : ''}
    </div>`
  }).join('')

  set('settings-current-model', current ? current.split(/[\\/]/).pop() : '--')
}

function renderModelCatalog() {
  const catalog = document.getElementById('model-catalog')
  if (!catalog) return

  catalog.innerHTML = CATALOG.map(m => `
    <div class="model-card" id="mcard-${m.id}">
      <div class="model-card-header">
        <span class="model-card-name">${m.name}</span>
        <span class="model-card-size">${m.size}</span>
        <span class="model-card-tag ${m.tag}">${m.tag.toUpperCase()}</span>
      </div>
      <div class="model-card-desc">${m.desc}</div>
      <div class="model-card-footer">
        <div class="model-dl-bar-wrap" id="dlbar-${m.id}"><div class="model-dl-bar" id="dlprog-${m.id}"></div></div>
        <div class="model-dl-pct" id="dlpct-${m.id}">0%</div>
        <span class="model-installed-badge" id="dlbadge-${m.id}">&#10003; Installed</span>
        <button class="btn btn-primary btn-sm" id="dlbtn-${m.id}" onclick="downloadCatalogModel('${m.id}')">Download</button>
      </div>
    </div>
  `).join('')

  // Mark already-installed models
  QE.listModels().then(models => {
    const installed = new Set(models.map(m => m.name))
    CATALOG.forEach(m => {
      if (installed.has(m.filename)) markModelInstalled(m.id)
    })
  })
}

async function downloadCatalogModel(id) {
  const m = CATALOG.find(c => c.id === id)
  if (!m || activeDownloads[id]) return

  const btn    = document.getElementById(`dlbtn-${id}`)
  const barWrap= document.getElementById(`dlbar-${id}`)
  const bar    = document.getElementById(`dlprog-${id}`)
  const pct    = document.getElementById(`dlpct-${id}`)

  activeDownloads[id] = true
  if (btn)    { btn.textContent = 'Cancel'; btn.onclick = () => cancelDownload(id) }
  if (barWrap) barWrap.style.display = 'block'
  if (pct)     pct.style.display = 'block'

  const progressHandler = (data) => {
    if (data.filename !== m.filename) return
    if (bar && data.pct >= 0) bar.style.width = data.pct + '%'
    if (pct) pct.textContent = data.pct >= 0 ? data.pct + '%' : formatBytes(data.received)
  }

  QE.on('model:downloadProgress', progressHandler)

  const result = await QE.downloadModel(m.url, m.filename)

  QE.off('model:downloadProgress', progressHandler)
  delete activeDownloads[id]

  if (result?.success) {
    markModelInstalled(id)
    await loadModels()
    renderInstalledModels()
  } else {
    if (barWrap) barWrap.style.display = 'none'
    if (pct)     pct.style.display = 'none'
    if (btn)    { btn.textContent = 'Download'; btn.onclick = () => downloadCatalogModel(id) }
    if (result?.error) alert(`Download failed: ${result.error}`)
  }
}

async function cancelDownload(id) {
  const m = CATALOG.find(c => c.id === id)
  if (!m) return
  delete activeDownloads[id]
  await QE.cancelModelDownload(m.filename)
  const btn = document.getElementById(`dlbtn-${id}`)
  const barWrap = document.getElementById(`dlbar-${id}`)
  const pct = document.getElementById(`dlpct-${id}`)
  if (btn)    { btn.textContent = 'Download'; btn.onclick = () => downloadCatalogModel(id) }
  if (barWrap) barWrap.style.display = 'none'
  if (pct)     pct.style.display = 'none'
}

function markModelInstalled(id) {
  const btn   = document.getElementById(`dlbtn-${id}`)
  const badge = document.getElementById(`dlbadge-${id}`)
  const barWrap = document.getElementById(`dlbar-${id}`)
  const pct     = document.getElementById(`dlpct-${id}`)
  if (btn)    btn.style.display = 'none'
  if (badge)  badge.style.display = 'inline'
  if (barWrap) barWrap.style.display = 'none'
  if (pct)    pct.style.display = 'none'
}

async function settingsLoadModel() {
  const sel = document.getElementById('settings-model-select')
  const ctx = document.getElementById('settings-ctx-select')
  const path = sel?.value
  if (!path) return

  const btn = document.getElementById('btn-settings-load-model')
  btn.disabled = true; btn.textContent = 'Loading...'
  setServerStatus('loading', 'Loading model...')

  const ctxSize  = parseInt(ctx?.value ?? '4096', 10)
  const modelName = path.split(/[\\/]/).pop().replace('.gguf', '')
  const result = await QE.startLlama({ model: path, ctxSize })

  if (result?.error) {
    setServerStatus('offline', 'Failed — check model file')
  } else {
    set('server-model-name', modelName)
    // Sync sidebar dropdown
    const sidebarSel = document.getElementById('sidebar-model-select')
    if (sidebarSel) sidebarSel.value = path
    await refreshServerStatus()
    renderInstalledModels()
  }

  btn.disabled = false; btn.textContent = '&#9654; Load'
}

function formatBytes(b) {
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1024 / 1024).toFixed(1) + ' MB'
}

// ── Simulation ────────────────────────────────────────────────────────────────
async function runSimulation() {
  if (state.generating) return
  const btn = document.getElementById('btn-run-sim')
  btn.disabled = true; btn.textContent = 'Running...'
  document.getElementById('sim-placeholder').style.display = 'none'
  document.getElementById('sim-output').style.display = 'block'
  document.getElementById('btn-save-sim').style.display = 'none'
  document.getElementById('sim-progress-bar').style.width = '0%'
  document.getElementById('sim-progress-text').textContent = 'Starting...'

  // Clear previous chat history when new simulation runs
  state.chatHistory = []
  document.getElementById('chat-messages').innerHTML = ''

  // Set up streaming target
  const llamaEl = document.getElementById('res-llama')
  llamaEl.innerHTML = '<span class="llama-thinking">Connecting to Llama AI...</span>'
  startStreaming(llamaEl)
  llamaEl.innerHTML = '' // clear placeholder once streaming starts

  const hours  = +document.getElementById('sim-hours').value
  const minMag = +document.getElementById('sim-minmag').value
  const result = await QE.runSimulation({ hours, minMag })

  stopStreaming()

  if (result?.error) {
    document.getElementById('sim-progress-text').textContent = 'Error: ' + result.error
    btn.disabled = false; btn.textContent = '&#9654; Run Simulation'
    return
  }

  state.lastSimResult = result
  renderSimResult(result)

  set('sim-timestamp', 'Run at ' + new Date(result.timestamp).toUTCString())
  document.getElementById('btn-save-sim').style.display = ''
  document.getElementById('sim-progress-text').textContent = 'Complete.'
  btn.disabled = false; btn.textContent = '&#9654; Run Simulation'

  // Seed chat context with simulation result
  if (result.llamaAnalysis) {
    state.chatHistory = [
      { role: 'user',      content: '[Simulation data provided above — initial analysis generated]' },
      { role: 'assistant', content: result.llamaAnalysis }
    ]
  }
}

function renderSimResult(result) {
  const { riskResult, llamaAnalysis, llamaAvailable } = result
  const overall = riskResult?.overall ?? {}, factors = riskResult?.factors ?? {}

  const scoreEl = document.getElementById('res-score')
  scoreEl.textContent = overall.score ?? '--'
  scoreEl.style.color = overall.color ?? 'var(--text)'
  const levelEl = document.getElementById('res-level')
  levelEl.textContent = overall.level ?? '--'
  levelEl.className = 'risk-level-badge ' + (overall.level ?? '')
  document.getElementById('s-risk-card').dataset.level = overall.level ?? ''
  set('s-risk',       overall.score ?? '--')
  set('s-risk-level', overall.level ?? '--')

  for (const [id, val] of [['tidal',factors.tidal],['solar',factors.solar],['geomag',factors.geomagnetic],['hist',factors.historical],['planet',factors.planetary]]) {
    const safe = Number.isFinite(val) ? val : 0
    document.getElementById('fb-' + id).style.width = safe + '%'
    set('fs-' + id, Number.isFinite(val) ? val : '--')
  }

  document.getElementById('res-regions').innerHTML = (riskResult?.regions ?? []).slice(0, 10).map(r => `
    <div class="region-row">
      <span class="rr-name">${r.region}</span>
      <span class="rr-score" style="color:${r.color}">${r.score}</span>
      <span class="rr-badge ${r.level}">${r.level}</span>
      <span style="font-size:10px;color:var(--text-dim);margin-left:8px">${r.quakeCount} eq, M${r.maxMag}</span>
    </div>`).join('')

  const llamaEl = document.getElementById('res-llama')
  if (llamaEl.textContent === '') { // nothing streamed yet (was pre-populated)
    if (!llamaAvailable) {
      llamaEl.innerHTML = '<span style="color:var(--text-muted)">Start the Llama server for AI analysis.</span>'
    } else {
      llamaEl.textContent = llamaAnalysis ?? '(no analysis)'
    }
  }
}

async function saveSimResult() {
  if (!state.lastSimResult) return
  await QE.saveHistory(state.lastSimResult)
  document.getElementById('btn-save-sim').textContent = 'Saved!'
  setTimeout(() => { document.getElementById('btn-save-sim').textContent = 'Save Result' }, 2000)
}

// ── Analyst chat ──────────────────────────────────────────────────────────────
async function sendChat() {
  if (state.generating) return
  const input = document.getElementById('chat-input')
  const text  = input.value.trim()
  if (!text) return
  input.value = ''

  // Add user message to UI
  appendChatMsg('user', text)

  // Build messages array: system prompt + sim context + history + new user msg
  const personality = state.personality
  const systemPrompt = buildSystemPromptFromPersonality()

  // Include sim summary as context if available
  let contextMsg = null
  if (state.lastSimResult?.riskResult) {
    const r = state.lastSimResult.riskResult
    contextMsg = {
      role: 'system',
      content: `Current simulation context: Risk index ${r.overall?.score ?? '?'}/100 (${r.overall?.level ?? '?'}). ` +
        `Tidal: ${r.factors?.tidal ?? '?'}, Solar: ${r.factors?.solar ?? '?'}, Geomag: ${r.factors?.geomagnetic ?? '?'}. ` +
        `Top region: ${r.regions?.[0]?.region ?? 'unknown'}.`
    }
  }

  const msgs = [
    { role: 'system', content: systemPrompt },
    ...(contextMsg ? [contextMsg] : []),
    ...state.chatHistory.slice(-8),  // last 4 exchanges
    { role: 'user', content: text }
  ]

  // Create assistant message bubble for streaming
  const assistantEl = appendChatMsg('assistant', '')
  const contentDiv  = assistantEl.querySelector('.msg-content')
  startStreaming(contentDiv)

  const result = await QE.analystChat(msgs)

  stopStreaming()

  const responseText = result?.response ?? result?.error ?? '(no response)'
  contentDiv.textContent = responseText

  // Save to history
  state.chatHistory.push({ role: 'user', content: text })
  state.chatHistory.push({ role: 'assistant', content: responseText })
}

function appendChatMsg(role, text) {
  const el = document.createElement('div')
  el.className = `chat-msg ${role}`
  el.innerHTML = `<div class="msg-role">${role === 'user' ? 'You' : 'Analyst AI'}</div><div class="msg-content">${text}</div>`
  const container = document.getElementById('chat-messages')
  container.appendChild(el)
  container.scrollTop = container.scrollHeight
  return el
}

// ── Personality ───────────────────────────────────────────────────────────────
async function loadPersonality() {
  state.personality = await QE.getPersonality()
}

function renderPersonalityForm() {
  const p = state.personality
  if (!p) return
  const el = (id) => document.getElementById(id)
  el('cfg-system').value = p.systemPrompt ?? ''
  el('cfg-temp').value  = p.temperature ?? 0.25;  set('cfg-temp-val',  (+(p.temperature ?? 0.25)).toFixed(2))
  el('cfg-topp').value  = p.topP ?? 0.9;           set('cfg-topp-val',  (+(p.topP ?? 0.9)).toFixed(2))
  el('cfg-topk').value  = p.topK ?? 40;             set('cfg-topk-val',  p.topK ?? 40)
  el('cfg-rep').value   = p.repeatPenalty ?? 1.1;  set('cfg-rep-val',   (+(p.repeatPenalty ?? 1.1)).toFixed(2))
  el('cfg-maxt').value  = p.maxTokens ?? 1200;      set('cfg-maxt-val',  p.maxTokens ?? 1200)
  el('cfg-mirostat').checked = p.mirostat ?? false
  el('mirostat-opts').style.display = p.mirostat ? '' : 'none'
  el('cfg-tau').value   = p.mirostatTau ?? 5;      set('cfg-tau-val',   (+(p.mirostatTau ?? 5)).toFixed(1))
  el('cfg-eta').value   = p.mirostatEta ?? 0.1;    set('cfg-eta-val',   (+(p.mirostatEta ?? 0.1)).toFixed(2))
}

async function savePersonality() {
  const p = {
    systemPrompt:  document.getElementById('cfg-system').value,
    temperature:   +document.getElementById('cfg-temp').value,
    topP:          +document.getElementById('cfg-topp').value,
    topK:          +document.getElementById('cfg-topk').value,
    repeatPenalty: +document.getElementById('cfg-rep').value,
    maxTokens:     +document.getElementById('cfg-maxt').value,
    mirostat:      document.getElementById('cfg-mirostat').checked,
    mirostatTau:   +document.getElementById('cfg-tau').value,
    mirostatEta:   +document.getElementById('cfg-eta').value
  }
  state.personality = p
  await QE.savePersonality(p)
  document.getElementById('btn-save-personality').textContent = 'Saved!'
  setTimeout(() => { document.getElementById('btn-save-personality').textContent = 'Save Profile' }, 2000)
}

function buildSystemPromptFromPersonality() {
  const base = state.personality?.systemPrompt || 'You are an expert seismic risk analyst.'
  const enabled = (state.skills ?? []).filter(s => s.enabled)
  if (!enabled.length) return base
  return base + '\n\nDOMAIN KNOWLEDGE:\n' + enabled.map(s => s.content).join('\n\n')
}

// ── Skills ────────────────────────────────────────────────────────────────────
async function loadSkills() { state.skills = await QE.getSkills() }

function renderSkillsList() {
  const el = document.getElementById('skills-list')
  el.innerHTML = (state.skills ?? []).map((sk, i) => `
    <div class="skill-card" data-idx="${i}">
      <div class="skill-header">
        <span class="skill-name">${sk.name}</span>
        <label class="skill-toggle">
          <input type="checkbox" ${sk.enabled ? 'checked' : ''} data-idx="${i}">
          <span class="skill-slider"></span>
        </label>
      </div>
      <textarea class="skill-content-edit" data-idx="${i}" rows="3">${sk.content}</textarea>
    </div>`).join('')

  el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      state.skills[+cb.dataset.idx].enabled = cb.checked
    })
  })
  el.querySelectorAll('textarea.skill-content-edit').forEach(ta => {
    ta.addEventListener('input', () => {
      state.skills[+ta.dataset.idx].content = ta.value
    })
  })
}

async function saveSkillsList() {
  await QE.saveSkills(state.skills)
  document.getElementById('btn-save-skills').textContent = 'Saved!'
  setTimeout(() => { document.getElementById('btn-save-skills').textContent = 'Save Skills' }, 2000)
}

function addCustomSkill() {
  state.skills.push({
    id: 'custom-' + Date.now(),
    name: 'Custom Skill',
    enabled: true,
    content: 'Describe the domain knowledge you want injected here...'
  })
  renderSkillsList()
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const history = await QE.getHistory()
  const el = document.getElementById('history-list')
  if (!history.length) {
    el.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim)">No saved simulations yet.</div>'
    return
  }
  el.innerHTML = history.map((h, i) => {
    const r = h.riskResult?.overall ?? {}
    return `<div class="history-card" data-idx="${i}">
      <div class="hc-row">
        <span class="hc-time">${new Date(h.timestamp).toUTCString()}</span>
        <span class="hc-score" style="color:${r.color ?? 'var(--text)'}">${r.score ?? '--'}</span>
        <span class="rr-badge ${r.level ?? ''}" style="margin-left:8px">${r.level ?? '--'}</span>
      </div>
      <div class="hc-preview">${h.llamaAnalysis ? h.llamaAnalysis.slice(0, 160) + '...' : 'No AI analysis'}</div>
    </div>`
  }).join('')

  el.querySelectorAll('.history-card').forEach((card, i) => {
    card.addEventListener('click', () => {
      showPanel('simulation')
      document.getElementById('sim-placeholder').style.display = 'none'
      document.getElementById('sim-output').style.display = 'block'
      renderSimResult(history[i])
      set('sim-timestamp', 'Loaded: ' + new Date(history[i].timestamp).toUTCString())
    })
  })
}

function showPanel(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  document.querySelector(`[data-panel="${name}"]`)?.classList.add('active')
  document.getElementById('panel-' + name)?.classList.add('active')
}

// ── Chart helpers ─────────────────────────────────────────────────────────────
function rebuildChart(key, canvasId, config) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key] }
  const canvas = document.getElementById(canvasId)
  if (!canvas) return
  state.charts[key] = new Chart(canvas.getContext('2d'), config)
}

function chartOpts(yLabel, yOptions = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#6b7fa3', font: { size: 9 }, maxTicksLimit: 8, maxRotation: 0 }, grid: { color: '#1e2535' } },
      y: { ...yOptions, ticks: { color: '#6b7fa3', font: { size: 9 } }, grid: { color: '#1e2535' },
           title: { display: !!yLabel, text: yLabel, color: '#3d4f72', font: { size: 10 } } }
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function set(id, val) {
  const el = document.getElementById(id)
  if (!el) return
  if (typeof val === 'number' && !Number.isFinite(val)) el.textContent = '--'
  else el.textContent = val ?? '--'
}
function safeNum(val, fallback = '--') {
  return (val != null && Number.isFinite(Number(val))) ? val : fallback
}
function timeAgo(date) {
  const m = Math.floor((Date.now() - date) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  return Math.floor(m / 60) + 'h ago'
}

// ── Statistics Panel ──────────────────────────────────────────────────────────
let statsSourceIds = null  // null = all

async function initSourceChips() {
  if (statsSourceIds !== null) return  // already built
  const sources = await QE.listSources()
  statsSourceIds = sources.map(s => s.id)
  const container = document.getElementById('stats-source-checks')
  container.innerHTML = sources.map(s => `
    <label class="source-chip active" title="${s.region} — min M${s.minMagFloor}">
      <input type="checkbox" value="${s.id}" checked>
      ${s.name}
    </label>`).join('')

  container.querySelectorAll('label').forEach(lbl => {
    lbl.addEventListener('click', e => {
      e.preventDefault()
      const cb = lbl.querySelector('input')
      cb.checked = !cb.checked
      lbl.classList.toggle('active', cb.checked)
      statsSourceIds = [...container.querySelectorAll('input:checked')].map(c => c.value)
    })
  })
}

async function loadStatsPanel() {
  await initSourceChips()
  const hoursEl  = document.getElementById('stats-hours')
  const hours    = +hoursEl.value
  const minMag   = +document.getElementById('stats-minmag').value
  const useDb    = hours >= 168

  document.getElementById('stats-db-note').style.display = useDb ? '' : 'none'
  set('stats-updated', 'Loading...')

  const stats = useDb
    ? await QE.statsDb({ days: Math.round(hours / 24), minMag })
    : await QE.statsLive({ hours, minMag, sourceIds: statsSourceIds })

  if (!stats || stats.error) {
    set('stats-updated', 'Error: ' + (stats?.error ?? 'unknown'))
    return
  }

  renderStats(stats, hours)
  set('stats-updated', 'Updated ' + timeAgo(new Date()))
}

function renderStats(s, hours) {
  // Threshold counts
  set('st-total', s.total)
  set('st-m2', s.thresholds?.m2 ?? '--')
  set('st-m3', s.thresholds?.m3 ?? '--')
  set('st-m4', s.thresholds?.m4 ?? '--')
  set('st-m5', s.thresholds?.m5 ?? '--')
  set('st-m6', s.thresholds?.m6 ?? '--')
  set('st-m7', s.thresholds?.m7 ?? '--')
  set('st-maxmag',  s.maxMag  != null ? 'M' + s.maxMag.toFixed(1) : '--')
  set('st-avgdepth', s.avgDepth != null ? s.avgDepth.toFixed(1) : '--')
  set('st-tsunami',  s.tsunamiCount ?? '--')

  // Trend
  const trend  = s.trend ?? { direction: 'flat', pct: 0 }
  const tIcon  = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→'
  const tSign  = trend.pct > 0 ? '+' : ''
  set('st-trend', tIcon + ' ' + tSign + (trend.pct ?? 0) + '%')
  set('st-trend-sub', 'vs prior ' + Math.round(hours / 2) + 'h')
  document.getElementById('st-trend-card').dataset.dir = trend.direction

  // Time series chart
  if (s.timeSeries?.length) {
    rebuildChart('stats-time', 'chart-stats-time', {
      type: 'bar',
      data: {
        labels: s.timeSeries.map(b => b.label),
        datasets: [{
          label: 'Events', data: s.timeSeries.map(b => b.count),
          backgroundColor: '#3b82f680', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 2
        }]
      },
      options: { ...chartOpts('Count'), plugins: { legend: { display: false } } }
    })
  }

  // Magnitude distribution
  if (s.byMag) {
    rebuildChart('stats-mag', 'chart-stats-mag', {
      type: 'bar',
      data: {
        labels: Object.keys(s.byMag),
        datasets: [{
          label: 'Events', data: Object.values(s.byMag),
          backgroundColor: ['#60a5fa','#34d399','#a3e635','#f59e0b','#f97316','#ef4444','#dc2626','#9333ea'],
          borderRadius: 4
        }]
      },
      options: { ...chartOpts('Count'), plugins: { legend: { display: false } } }
    })
  }

  // Depth distribution
  if (s.depthBuckets) {
    rebuildChart('stats-depth', 'chart-stats-depth', {
      type: 'doughnut',
      data: {
        labels: Object.keys(s.depthBuckets),
        datasets: [{
          data: Object.values(s.depthBuckets),
          backgroundColor: ['#3b82f6', '#f59e0b', '#ef4444'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom', labels: { color: '#6b7fa3', font: { size: 10 }, boxWidth: 10 } } }
      }
    })
  }

  // Top regions chart
  if (s.topRegions?.length) {
    const top = s.topRegions.slice(0, 10)
    rebuildChart('stats-region', 'chart-stats-region', {
      type: 'bar',
      data: {
        labels: top.map(r => r.name.length > 20 ? r.name.slice(0, 18) + '…' : r.name),
        datasets: [{
          label: 'Events', data: top.map(r => r.count),
          backgroundColor: '#3b82f680', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 3
        }]
      },
      options: {
        ...chartOpts('Count'),
        indexAxis: 'y',
        plugins: { legend: { display: false } }
      }
    })
  }

  // Source breakdown bars
  if (s.bySource) {
    const total = Object.values(s.bySource).reduce((a, b) => a + b, 0) || 1
    const colors = { USGS: '#3b82f6', EMSC: '#f59e0b', INGV: '#22c55e', NRCan: '#ec4899', GFZ: '#8b5cf6', NCEDC: '#06b6d4' }
    document.getElementById('stats-source-bars').innerHTML = Object.entries(s.bySource)
      .sort((a, b) => b[1] - a[1])
      .map(([src, cnt]) => `
        <div class="source-bar-row">
          <span class="source-bar-name">${src}</span>
          <div class="source-bar-bg"><div class="source-bar-fill" style="width:${(cnt / total * 100).toFixed(1)}%;background:${colors[src] ?? 'var(--accent)'}"></div></div>
          <span class="source-bar-count">${cnt}</span>
        </div>`).join('')
  }

  // Depth classification detail
  if (s.depthBuckets) {
    const total = Object.values(s.depthBuckets).reduce((a, b) => a + b, 0) || 1
    document.getElementById('stats-depth-detail').innerHTML = Object.entries(s.depthBuckets).map(([k, v]) => `
      <div class="depth-detail-row">
        <span style="color:var(--text-muted)">${k}</span>
        <span style="font-family:var(--mono)">${v} <span style="color:var(--text-dim);font-size:10px">(${(v / total * 100).toFixed(0)}%)</span></span>
      </div>`).join('')
  }
}

// ── Quake News Panel ──────────────────────────────────────────────────────────
async function loadQuakeNews() {
  const hours  = +document.getElementById('qnews-hours').value
  const minMag = +document.getElementById('qnews-minmag').value
  const loading = document.getElementById('qnews-loading')
  const list    = document.getElementById('qnews-swarms-list')

  loading.style.display = ''
  list.innerHTML = ''
  set('qnews-updated', 'Scanning...')

  const result = await QE.detectSwarms({ hours, minMag })

  loading.style.display = 'none'

  if (result?.error) {
    list.innerHTML = `<div class="qnews-empty">Error: ${result.error}</div>`
    return
  }

  const swarms = result?.swarms ?? []
  set('qnews-updated', `${swarms.length} sequences detected · ${result.quakeCount ?? '?'} quakes scanned · ${timeAgo(new Date())}`)
  document.getElementById('qnews-meta').textContent =
    `Scanned ${result.quakeCount ?? '?'} earthquakes (M${minMag}+) from the last ${hours >= 168 ? Math.round(hours/24) + ' days' : hours + 'h'} across USGS, EMSC, INGV, NRCan networks.`

  if (!swarms.length) {
    list.innerHTML = `<div class="qnews-empty">No significant swarms or sequences detected in this window.<br>Try a longer time range or lower minimum magnitude.</div>`
    return
  }

  list.innerHTML = swarms.map(sw => renderSwarmCard(sw)).join('')

  // Map view buttons
  list.querySelectorAll('.swarm-map-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lat = +btn.dataset.lat, lon = +btn.dataset.lon
      showPanel('dashboard')
      setTimeout(() => {
        if (state.map) {
          state.map.setView([lat, lon], 7)
          state.map.invalidateSize()
        }
      }, 80)
    })
  })
}

function renderSwarmCard(sw) {
  const durationLabel = sw.durationH < 1
    ? '<1h'
    : sw.durationH < 24
      ? sw.durationH.toFixed(0) + 'h'
      : (sw.durationH / 24).toFixed(1) + 'd'

  const lastSeen = timeAgo(new Date(sw.lastTime))

  return `<div class="swarm-card" data-severity="${sw.severity}">
    <div class="swarm-header">
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span class="swarm-type-badge ${sw.type}">${sw.type}</span>
          ${sw.isActive ? '<span class="active-pill">ACTIVE</span>' : '<span class="inactive-pill">QUIET</span>'}
          <span class="trend-badge ${sw.trend}">${sw.trend === 'ACCELERATING' ? '▲' : sw.trend === 'DECELERATING' ? '▼' : '→'} ${sw.trend}</span>
        </div>
        <div class="swarm-region">${sw.region}</div>
        <div class="swarm-place">${sw.place !== sw.region ? sw.place : ''}</div>
      </div>
    </div>
    <div class="swarm-meta">
      <div class="swarm-meta-item"><span class="swm-label">Events</span><span class="swm-val">${sw.count}</span></div>
      <div class="swarm-meta-item"><span class="swm-label">Max Mag</span><span class="swm-val" style="color:${sw.maxMag >= 6 ? 'var(--high)' : sw.maxMag >= 5 ? 'var(--elevated)' : sw.maxMag >= 4 ? 'var(--moderate)' : 'var(--text)'}">M${sw.maxMag}</span></div>
      <div class="swarm-meta-item"><span class="swm-label">Mag Range</span><span class="swm-val">M${sw.minMag}–M${sw.maxMag}</span></div>
      <div class="swarm-meta-item"><span class="swm-label">Duration</span><span class="swm-val">${durationLabel}</span></div>
      <div class="swarm-meta-item"><span class="swm-label">Avg Depth</span><span class="swm-val">${sw.avgDepth} km</span></div>
      <div class="swarm-meta-item"><span class="swm-label">Last Event</span><span class="swm-val" style="font-size:11px">${lastSeen}</span></div>
    </div>
    <div class="swarm-footer">
      <button class="btn btn-ghost btn-sm swarm-map-btn" data-lat="${sw.lat}" data-lon="${sw.lon}">&#9654; View on Map</button>
      <span class="swarm-sources">Sources: ${sw.sources.join(', ')}</span>
      <span style="font-size:10px;color:var(--text-dim);margin-left:auto">${sw.lat.toFixed(2)}°, ${sw.lon.toFixed(2)}°</span>
    </div>
  </div>`
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init)
