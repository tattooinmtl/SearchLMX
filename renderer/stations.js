'use strict'

// ── Live Stations module ──────────────────────────────────────────────────────
// Integrated from standalone stations.html; scoped to panel-stations.

const ST = {
  DATA_CENTERS: {
    earthscope: {
      label: 'EarthScope',
      stationUrl:    'https://service.earthscope.org/fdsnws/station/1/query',
      dataselectUrl: 'https://service.earthscope.org/fdsnws/dataselect/1/query',
      networks: { IU: 'USGS Global', II: 'IRIS/IDA', G: 'GEOSCOPE', US: 'US National', AK: 'Alaska', IC: 'IRIS/Cariaco' }
    },
    canada: {
      label: 'Canada',
      stationUrl:    'https://www.earthquakescanada.nrcan.gc.ca/fdsnws/station/1/query',
      dataselectUrl: 'https://www.earthquakescanada.nrcan.gc.ca/fdsnws/dataselect/1/query',
      networks: { CN: 'Canadian National' }
    },
    ncedc: {
      label: 'NCEDC',
      stationUrl:    'https://service.ncedc.org/fdsnws/station/1/query',
      dataselectUrl: 'https://service.ncedc.org/fdsnws/dataselect/1/query',
      networks: { NC: 'N.California', BK: 'Berkeley', NN: 'Nevada' }
    },
    scedc: {
      label: 'SCEDC',
      stationUrl:    'https://service.scedc.caltech.edu/fdsnws/station/1/query',
      dataselectUrl: 'https://service.scedc.caltech.edu/fdsnws/dataselect/1/query',
      networks: { CI: 'S.California', AZ: 'Arizona' }
    },
    ingv: {
      label: 'INGV',
      stationUrl:    'https://webservices.ingv.it/fdsnws/station/1/query',
      dataselectUrl: 'https://webservices.ingv.it/fdsnws/dataselect/1/query',
      networks: { IV: 'Italy', MN: 'MedNet' }
    },
    gfz: {
      label: 'GFZ',
      stationUrl:    'https://geofon.gfz-potsdam.de/fdsnws/station/1/query',
      dataselectUrl: 'https://geofon.gfz-potsdam.de/fdsnws/dataselect/1/query',
      networks: { GE: 'GEOFON', TW: 'BATS Taiwan' }
    }
  },

  // state
  currentStation:       null,
  currentStream:        null,
  currentWindowSeconds: 60,
  liveTimer:            null,
  allStations:          [],
  initialized:          false
}

// ── Init (called once when the panel is first opened) ────────────────────────
function initStationsPanel() {
  if (ST.initialized) return
  ST.initialized = true

  const centerSel  = document.getElementById('st-center-select')
  const networkSel = document.getElementById('st-network-select')

  populateNetworks()
  centerSel.addEventListener('change', () => { populateNetworks(); stLoadStations() })
  networkSel.addEventListener('change', stLoadStations)

  document.getElementById('st-window-btns').addEventListener('click', e => {
    const btn = e.target.closest('.st-win-btn')
    if (!btn) return
    document.querySelectorAll('.st-win-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    ST.currentWindowSeconds = parseInt(btn.dataset.seconds, 10)
    if (ST.currentStation && ST.currentStream) stDoFetch()
  })

  document.getElementById('st-wf-close').addEventListener('click', () => {
    if (ST.liveTimer) { clearInterval(ST.liveTimer); ST.liveTimer = null }
    ST.currentStation = null
    ST.currentStream  = null
    document.getElementById('st-wf-title').textContent = 'Waveform Viewer'
    document.getElementById('st-wf-status').textContent = 'Click a station to view live waveform'
    stClearWaveform()
    document.querySelectorAll('.st-item').forEach(el => el.classList.remove('active'))
  })

  stLoadStations()
}

function populateNetworks() {
  const centerSel  = document.getElementById('st-center-select')
  const networkSel = document.getElementById('st-network-select')
  const c = ST.DATA_CENTERS[centerSel.value]
  networkSel.innerHTML = ''
  for (const [k] of Object.entries(c.networks)) {
    const o = document.createElement('option')
    o.value = k; o.textContent = k
    networkSel.appendChild(o)
  }
}

// ── Load station list ────────────────────────────────────────────────────────
async function stLoadStations() {
  const centerSel  = document.getElementById('st-center-select')
  const networkSel = document.getElementById('st-network-select')
  const list       = document.getElementById('st-station-list')
  const statsEl    = document.getElementById('st-stats')
  const c   = ST.DATA_CENTERS[centerSel.value]
  const net = networkSel.value

  list.innerHTML = '<div style="padding:10px;color:var(--text-dim);font-size:12px">Loading stations...</div>'
  statsEl.textContent = 'Loading...'
  stClearWaveform()

  try {
    // endafter = 2 years ago to get active stations
    const d = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 19)
    const urls = [
      c.stationUrl + '?net=' + encodeURIComponent(net) + '&format=text&level=station&endafter=' + encodeURIComponent(d),
      c.stationUrl + '?network=' + encodeURIComponent(net) + '&format=text&level=station&endafter=' + encodeURIComponent(d)
    ]
    let text = ''
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(18000) })
        if (res.ok) { text = await res.text(); break }
      } catch { /* try next */ }
    }
    if (!text) throw new Error('No data from FDSN station service')

    const rows = text.split('\n').filter(l => l && !l.startsWith('#'))
    ST.allStations = rows.map(r => {
      const p = r.split('|')
      return p.length >= 6 ? { code: p[0] + '.' + p[1], net: p[0], sta: p[1], lat: +p[2], lon: +p[3], name: p.slice(5).join('|').trim() } : null
    }).filter(Boolean)

    stRenderStations()
    statsEl.textContent = ST.allStations.length + ' stations · ' + c.label + ' · ' + net
  } catch (e) {
    list.innerHTML = '<div style="padding:10px;color:#f87171;font-size:11px">Error: ' + stEsc(e.message) + '</div>'
    statsEl.textContent = 'Error loading'
  }
}

function stRenderStations() {
  const list = document.getElementById('st-station-list')
  list.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const s of ST.allStations) {
    const div = document.createElement('div')
    div.className = 'st-item' + (ST.currentStation?.code === s.code ? ' active' : '')
    div.innerHTML = '<div class="st-code">' + stEsc(s.code) + '</div><div class="st-name">' + stEsc(s.name) + '</div>'
    div.addEventListener('click', (e) => stOpenStation(s, e.currentTarget))
    frag.appendChild(div)
  }
  list.appendChild(frag)
}

// ── Open a station ────────────────────────────────────────────────────────────
async function stOpenStation(station, clickedEl) {
  ST.currentStation = station
  if (ST.liveTimer) { clearInterval(ST.liveTimer); ST.liveTimer = null }
  stClearWaveform()

  document.querySelectorAll('.st-item').forEach(el => el.classList.remove('active'))
  if (clickedEl) clickedEl.classList.add('active')

  const title  = document.getElementById('st-wf-title')
  const status = document.getElementById('st-wf-status')
  const ph     = document.getElementById('st-placeholder')

  title.textContent  = station.code + ' — ' + station.name
  status.textContent = 'Discovering channels...'
  ph.textContent     = 'Discovering channels for ' + station.code + '...'
  ph.style.display   = 'flex'

  const stream = await stDiscoverStream(station)
  if (!stream) {
    status.textContent = 'No live channels available'
    ph.textContent     = 'No live MiniSEED stream found for this station.'
    return
  }
  ST.currentStream   = stream
  status.textContent = 'Live ' + stream.cha + '/' + stream.loc + ' · updating every 10s'
  await stDoFetch()
  ST.liveTimer = setInterval(stDoFetch, 10000)
}

// ── Discover best channel ────────────────────────────────────────────────────
async function stDiscoverStream(station) {
  const centerSel = document.getElementById('st-center-select')
  const c     = ST.DATA_CENTERS[centerSel.value]
  const start = new Date(Date.now() - 86400000).toISOString()
  const end   = new Date().toISOString()
  const prio  = ['BHZ', 'HHZ', 'EHZ', 'SHZ', 'LHZ', 'BH1', 'BH2']

  const urls = [
    c.stationUrl + '?level=channel&format=text&net=' + encodeURIComponent(station.net) + '&sta=' + encodeURIComponent(station.sta) + '&starttime=' + encodeURIComponent(start) + '&endtime=' + encodeURIComponent(end),
    c.stationUrl + '?level=channel&format=text&network=' + encodeURIComponent(station.net) + '&station=' + encodeURIComponent(station.sta) + '&starttime=' + encodeURIComponent(start) + '&endtime=' + encodeURIComponent(end)
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) continue
      const text = await res.text()
      const chs  = text.split('\n').filter(l => l && !l.startsWith('#')).map(r => r.split('|')).filter(p => p.length >= 4)
      for (const cName of prio) {
        const match = chs.find(p => p[3] === cName)
        if (!match) continue
        const loc = (match[2] && match[2] !== '--') ? match[2] : '*'
        const ok  = await stTestData(station, cName, loc)
        if (ok) return { cha: cName, loc }
      }
    } catch { continue }
  }
  return null
}

function stGetDataselectEndpoints() {
  const centerSel = document.getElementById('st-center-select')
  const active = ST.DATA_CENTERS[centerSel.value]
  const others = Object.values(ST.DATA_CENTERS).filter(c => c.dataselectUrl !== active.dataselectUrl)
  return [active, ...others].map(c => c.dataselectUrl)
}

async function stFetchFromAny(station, cha, loc, windowSec) {
  const e  = new Date()
  const s  = new Date(e.getTime() - windowSec * 1000)
  const si = s.toISOString().replace('Z', '')
  const ei = e.toISOString().replace('Z', '')

  for (const url of stGetDataselectEndpoints()) {
    const u = url + '?net=' + encodeURIComponent(station.net) +
      '&sta=' + encodeURIComponent(station.sta) +
      '&loc=' + encodeURIComponent(loc) +
      '&cha=' + encodeURIComponent(cha) +
      '&starttime=' + encodeURIComponent(si) +
      '&endtime='   + encodeURIComponent(ei) +
      '&format=miniseed'
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) })
      if (!r.ok) continue
      const b = await r.arrayBuffer()
      if (b.byteLength > 0) return b
    } catch { continue }
  }
  return null
}

async function stTestData(station, cha, loc) {
  const buf = await stFetchFromAny(station, cha, loc, 60)
  return buf !== null && buf.byteLength > 0
}

// ── Fetch & draw ──────────────────────────────────────────────────────────────
async function stDoFetch() {
  if (!ST.currentStation || !ST.currentStream) return
  const status = document.getElementById('st-wf-status')
  try {
    const buf = await stFetchFromAny(ST.currentStation, ST.currentStream.cha, ST.currentStream.loc, ST.currentWindowSeconds)
    if (!buf || buf.byteLength === 0) { status.textContent = 'No MiniSEED data currently available.'; return }
    const parsed = stParseMiniSEED(new Uint8Array(buf), 50000)
    if (!parsed || parsed.length === 0) { status.textContent = 'No samples in MiniSEED data.'; return }
    const step = Math.ceil(parsed.length / 5000)
    const ds   = parsed.filter((_, i) => i % step === 0)
    stDrawWaveform(ds)
    const now  = new Date().toLocaleTimeString()
    status.textContent = ST.currentStation.code + ' ' + ST.currentStream.cha + '/' + ST.currentStream.loc + ' · ' + parsed.length + ' pts · ' + now
  } catch {
    status.textContent = 'Waveform fetch failed — retrying...'
  }
}

function stClearWaveform() {
  const canvas = document.getElementById('st-waveform-canvas')
  const ph     = document.getElementById('st-placeholder')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  canvas.style.display   = 'none'
  ph.style.display       = 'flex'
  ph.textContent         = 'Click a station on the left to view live waveform data'
}

// ── Draw waveform ─────────────────────────────────────────────────────────────
function stDrawWaveform(data) {
  const canvas = document.getElementById('st-waveform-canvas')
  const ph     = document.getElementById('st-placeholder')
  if (!canvas) return

  const parent = canvas.parentElement
  const rect   = parent.getBoundingClientRect()
  canvas.width  = rect.width  || 800
  canvas.height = rect.height || 300

  const ctx = canvas.getContext('2d')
  const w = canvas.width, h = canvas.height

  ctx.fillStyle = '#080c14'
  ctx.fillRect(0, 0, w, h)

  // Grid lines
  ctx.strokeStyle = '#1a2030'
  ctx.lineWidth   = 0.5
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); ctx.stroke()
  }
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath(); ctx.moveTo(w * i / 8, 0); ctx.lineTo(w * i / 8, h); ctx.stroke()
  }

  let min = Infinity, max = -Infinity
  for (const v of data) { if (v < min) min = v; if (v > max) max = v }
  const range   = max - min || 1
  const mid     = (max + min) / 2
  const padded  = range * 1.25
  const yMin    = mid - padded / 2
  const yMax    = mid + padded / 2

  // Waveform
  ctx.strokeStyle = '#3b88fd'
  ctx.lineWidth   = 1
  ctx.beginPath()
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w
    const y = h - ((data[i] - yMin) / (yMax - yMin)) * h
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Centre baseline
  ctx.strokeStyle = '#334155'
  ctx.lineWidth   = 0.5
  ctx.setLineDash([5, 5])
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
  ctx.setLineDash([])

  // Min / max labels
  ctx.fillStyle  = '#4b6080'
  ctx.font       = '10px monospace'
  ctx.fillText('max: ' + max.toFixed(0), 6, 14)
  ctx.fillText('min: ' + min.toFixed(0), 6, h - 6)

  ph.style.display     = 'none'
  canvas.style.display = 'block'
}

// ── MiniSEED parser ───────────────────────────────────────────────────────────
function stParseMiniSEED(data, maxSamples = 50000) {
  const all = []; let off = 0
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  while (off + 64 <= data.byteLength) {
    try {
      const rec = stParseRecord(dv, data, off)
      if (!rec) break
      if (!isFinite(rec.len) || rec.len < 64) break
      if (off + rec.len > data.byteLength) break
      const prev = off
      for (const s of rec.samples) { all.push(s); if (all.length >= maxSamples) break }
      off += rec.len
      if (off <= prev) break
      if (all.length >= maxSamples) break
    } catch { break }
  }
  return all
}

function stParseRecord(dv, data, off) {
  if (off + 48 > dv.byteLength) return null
  const ns  = dv.getInt16(off + 30, false)
  const dbo = dv.getUint16(off + 44, false)
  const bbo = dv.getUint16(off + 46, false)
  if (ns <= 0 || dbo === 0) return null
  let rl = 4096, enc = 11
  if (bbo > 0 && bbo < 512) {
    let bo = off + bbo
    for (let i = 0; i < 10; i++) {
      if (bo + 4 > dv.byteLength) break
      const bt = dv.getUint16(bo, false)
      const nb = dv.getUint16(bo + 2, false)
      if (bt === 1000 && bo + 8 <= dv.byteLength) { enc = dv.getUint8(bo + 4); rl = Math.pow(2, dv.getUint8(bo + 6)); break }
      if (nb === 0 || nb <= bo - off) break
      bo = off + nb
    }
  }
  if (!isFinite(rl) || rl < 64 || rl > 65536) return null
  if (dbo >= rl || off + rl > dv.byteLength) return null
  return { samples: stDecodeSamples(dv, off + dbo, ns, enc), len: rl }
}

function stDecodeSamples(dv, doff, ns, enc) {
  const s = []
  if (enc === 1) {
    for (let i = 0; i < ns; i++) { const p = doff + i * 2; if (p + 2 > dv.byteLength) break; s.push(dv.getInt16(p, false)) }
  } else if (enc === 3 || enc === 11) {
    for (let i = 0; i < ns; i++) { const p = doff + i * 4; if (p + 4 > dv.byteLength) break; s.push(dv.getInt32(p, false)) }
  } else if (enc === 4 || enc === 12) {
    for (let i = 0; i < ns; i++) { const p = doff + i * 4; if (p + 4 > dv.byteLength) break; s.push(dv.getFloat32(p, false)) }
  } else if (enc === 5) {
    for (let i = 0; i < ns; i++) { const p = doff + i * 8; if (p + 8 > dv.byteLength) break; s.push(dv.getFloat64(p, false)) }
  } else if (enc === 10 || enc === 19) {
    return stDecodeSteim(dv, doff, ns)
  } else {
    for (let i = 0; i < ns; i++) { const p = doff + i * 4; if (p + 4 > dv.byteLength) break; s.push(dv.getInt32(p, false)) }
  }
  return s
}

function stDecodeSteim(dv, doff, ns) {
  const s = []; let last = 0; let fo = doff; let first = true
  while (s.length < ns && fo + 64 <= dv.byteLength) {
    const cw = dv.getUint32(fo, false)
    for (let w = 1; w <= 15 && s.length < ns; w++) {
      const dn  = (cw >>> (30 - w * 2)) & 3
      const wv  = dv.getInt32(fo + w * 4, false)
      if (first && w === 1) { last = wv; first = false; continue }
      if (w === 2 && fo === doff) continue
      if (dn === 0) continue
      if (dn === 1) { for (let b = 3; b >= 0 && s.length < ns; b--) { const d = (wv >> (b * 8)) & 255; last += (d & 128) ? d - 256 : d; s.push(last) } }
      else if (dn === 2) { for (let b = 1; b >= 0 && s.length < ns; b--) { const r = (wv >> (b * 16)) & 65535; last += r > 32767 ? r - 65536 : r; s.push(last) } }
      else if (dn === 3) { last += wv; s.push(last) }
    }
    fo += 64
  }
  return s
}

function stEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
