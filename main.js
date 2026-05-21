const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path  = require('path')
const fs    = require('fs')
const https = require('https')
const http  = require('http')
const os    = require('os')
const { execSync } = require('child_process')

// ── Runtime paths (dev vs packaged) ──────────────────────────────────────────
// __dirname contains 'app.asar' when packaged; safe to check at module eval time
const IS_PACKAGED = __dirname.includes('app.asar') || (process.resourcesPath && !__dirname.startsWith(process.cwd()))
const LLAMA_DIR   = IS_PACKAGED
  ? path.join(process.resourcesPath, 'llama')
  : path.join(__dirname, 'llama')
// MODELS_DIR and DATA_DIR need app.getPath — resolved inside whenReady via initPaths()
let MODELS_DIR  = path.join(__dirname, 'Models')
let DATA_DIR    = path.join(__dirname, 'data')
let HISTORY_FILE, PERSONALITY_FILE, SKILLS_FILE

function initPaths() {
  if (app.isPackaged) {
    const userData = app.getPath('userData')
    MODELS_DIR  = path.join(userData, 'Models')
    DATA_DIR    = path.join(userData, 'data')
  }
  HISTORY_FILE     = path.join(DATA_DIR, 'history.json')
  PERSONALITY_FILE = path.join(DATA_DIR, 'personality.json')
  SKILLS_FILE      = path.join(DATA_DIR, 'skills.json')
  process.env.SEARCHLMX_LLAMA_DIR  = LLAMA_DIR
  process.env.SEARCHLMX_MODELS_DIR = MODELS_DIR
  fs.mkdirSync(DATA_DIR,   { recursive: true })
  fs.mkdirSync(MODELS_DIR, { recursive: true })
}

const sources       = require('./engine/sources')
const usgs          = sources  // backward compat alias
const solar         = require('./engine/solar')
const planetary     = require('./engine/planetary')
const llamaClient   = require('./engine/llama-client')
const simulation    = require('./engine/simulation')
const quakeDb       = require('./engine/quake-db')
const statsEngine   = require('./engine/stats-engine')
const swarmDetector = require('./engine/swarm-detector')

const DEFAULT_PERSONALITY = {
  systemPrompt:  simulation.DEFAULT_SYSTEM_PROMPT,
  temperature:   0.25,
  topP:          0.9,
  topK:          40,
  repeatPenalty: 1.1,
  maxTokens:     1200,
  mirostat:      false,
  mirostatTau:   5.0,
  mirostatEta:   0.1
}

const DEFAULT_SKILLS = [
  {
    id: 'seismology', name: 'Seismology Expert', enabled: true,
    content: 'You have deep expertise in seismology: Gutenberg-Richter law (log N = a - bM), elastic rebound theory, aftershock sequences following Omori\'s law, tidal triggering (small but measurable), and dynamic stress transfer from large earthquakes.'
  },
  {
    id: 'solar-physics', name: 'Solar Physics', enabled: true,
    content: 'You understand space weather: X-class flares cause strong X-ray/proton flux; southward IMF Bz allows solar wind magnetospheric coupling; Kp≥5 indicates significant geomagnetic disturbance; solar wind >500 km/s is elevated. Solar-seismic correlation is debated but Kp storms may affect crustal electrical currents.'
  },
  {
    id: 'tidal-mechanics', name: 'Tidal Mechanics', enabled: true,
    content: 'You understand tidal forces: Sun provides 46% of Moon\'s tidal effect; spring tides (new/full moon) enhance combined tidal stress by ~46%; perigean spring tides add another 25% when Moon is at closest approach; tidal modulation of seismicity is strongest on thrust and normal faults near tidal stress maxima.'
  },
  {
    id: 'planetary-science', name: 'Planetary Science', enabled: false,
    content: 'You understand planetary gravitational effects: Jupiter\'s tidal force on Earth is ~8400× smaller than the Moon\'s, Saturn\'s ~17700×. While scientifically minimal, planetary alignments (especially Jupiter-Sun conjunctions/oppositions) create slight gravitational gradient changes. Venus at inferior conjunction is closest to Earth and has maximum effect of the planets.'
  },
  {
    id: 'statistical-analysis', name: 'Statistical Analysis', enabled: false,
    content: 'You apply statistical methods to seismic data: frequency-magnitude distributions, ETAS (Epidemic-Type Aftershock Sequences) models, Poisson processes for background seismicity, and probability estimation for large earthquakes using Gutenberg-Richter extrapolation.'
  }
]

let mainWindow = null

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { return def }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

let splashWindow = null

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 560, height: 560,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#060a12',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0a0e1a',
    frame: false,
    show: false,   // hidden until splash finishes
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function getSysInfo() {
  const totalRam = os.totalmem()
  const freeRam  = os.freemem()
  const cpus     = os.cpus()
  const cpuName  = cpus[0]?.model?.trim() ?? 'Unknown CPU'
  const cores    = cpus.length

  // Disk space on Windows via WMIC
  let diskTotal = 0, diskFree = 0
  try {
    const raw = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /format:value', { timeout: 3000 })
      .toString()
    const freeMatch  = raw.match(/FreeSpace=(\d+)/)
    const totalMatch = raw.match(/Size=(\d+)/)
    if (freeMatch)  diskFree  = parseInt(freeMatch[1],  10)
    if (totalMatch) diskTotal = parseInt(totalMatch[1], 10)
  } catch { /* wmic unavailable */ }

  return {
    os:        `${os.type()} ${os.release()} (${os.arch()})`,
    cpu:       cpuName,
    cores,
    totalRam,
    freeRam,
    diskTotal,
    diskFree
  }
}

function splashStep(text, type = 'ok') {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:step', { text, type })
  }
}

async function bootSequence() {
  initPaths()
  createSplash()
  createWindow()

  // Wait for splash to signal DOM ready
  await new Promise(resolve => ipcMain.once('splash:ready', resolve))

  // Send system info
  splashWindow?.webContents.send('splash:sysinfo', getSysInfo())
  await delay(120)

  splashStep('Engine core loaded — sources, solar, planetary modules')
  await delay(250)

  splashStep('Quake database initializing — reading month shards')
  await delay(200)

  splashStep('USGS / EMSC / INGV / NRCan / GFZ / NCEDC endpoints ready')
  await delay(200)

  splashStep('NOAA SWPC solar weather interface ready')
  await delay(180)

  splashStep('Astronomy engine — tidal & planetary calculator ready')
  await delay(180)

  splashStep('Swarm detection & stats engine loaded')
  await delay(150)

  splashStep('Llama.cpp server interface ready — checking for model')
  const models = getInstalledModels()
  if (models.length > 0) {
    splashStep(`Model directory OK — ${models.length} model(s) found`)
  } else {
    splashStep('No models found — use Settings → Download Models', 'warn')
  }
  await delay(200)

  // Wait for main window to finish loading
  await new Promise(resolve => {
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', resolve)
    } else {
      resolve()
    }
  })

  splashStep('UI renderer ready — all panels loaded')
  await delay(200)

  splashStep('SearchLMx Quake Engine ready')
  await delay(300)

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:done')
    await delay(500)
    splashWindow.close()
  }
  splashWindow = null
  mainWindow.show()
}

function getInstalledModels() {
  try {
    return fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.gguf'))
  } catch { return [] }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

app.whenReady().then(bootSequence)
app.on('window-all-closed', () => { llamaClient.stopServer(); app.quit() })

// ── Shell ─────────────────────────────────────────────────────────────────────
ipcMain.on('shell:open', (_, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url)
  }
})

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => { llamaClient.stopServer(); mainWindow?.close() })

// ── Data collectors ──────────────────────────────────────────────────────────
ipcMain.handle('quake:getData', async (_, opts = {}) => {
  try {
    const data = await usgs.fetchRecentQuakes(opts.hours ?? 24, opts.minMag ?? 0.1)
    // Auto-save to local database in the background
    if (data?.quakes?.length) {
      setImmediate(() => quakeDb.saveQuakes(data.quakes))
    }
    return data
  } catch (e) { return { error: e.message, quakes: [], pattern: {} } }
})

ipcMain.handle('solar:getData', async () => {
  try { return await solar.fetchAllSolarData() }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('planetary:getData', async () => {
  try { return planetary.getCurrentPlanetaryData() }
  catch (e) { return { error: e.message } }
})

// ── Simulation (with streaming) ───────────────────────────────────────────────
ipcMain.handle('simulation:run', async (event, opts = {}) => {
  const send    = (data)  => event.sender.send('simulation:progress', data)
  const onToken = (token) => event.sender.send('llama:token', token)
  const personality = readJson(PERSONALITY_FILE, DEFAULT_PERSONALITY)

  const simOpts = {
    ...opts,
    systemPrompt:  buildSystemPrompt(personality),
    temperature:   personality.temperature,
    topP:          personality.topP,
    topK:          personality.topK,
    repeatPenalty: personality.repeatPenalty,
    maxTokens:     personality.maxTokens,
    mirostat:      personality.mirostat,
    mirostatTau:   personality.mirostatTau,
    mirostatEta:   personality.mirostatEta
  }

  try { return await simulation.runSimulation(simOpts, send, onToken) }
  catch (e) { return { error: e.message } }
})

// ── Analyst chat (streaming) ──────────────────────────────────────────────────
ipcMain.handle('analyst:chat', async (event, { messages }) => {
  const onToken   = (token) => event.sender.send('llama:token', token)
  const personality = readJson(PERSONALITY_FILE, DEFAULT_PERSONALITY)
  try {
    const response = await llamaClient.streamAnalyze(messages, 8080, onToken, personality)
    return { response }
  } catch (e) { return { error: e.message } }
})

// ── Llama server ──────────────────────────────────────────────────────────────
ipcMain.handle('llama:start', async (event, opts = {}) => {
  const modelPath = opts.model ?? path.join(MODELS_DIR, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf')
  const port = opts.port ?? 8080
  const ctxSize = opts.ctxSize ?? 4096
  const send = (msg) => event.sender.send('llama:startProgress', { step: msg, pct: 40 })
  try {
    await llamaClient.stopServer()
    await llamaClient.startServer(modelPath, port, send, { ctxSize })
    return { success: true }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('llama:stop',   async () => { llamaClient.stopServer(); return { success: true } })
ipcMain.handle('llama:status', async () => ({ running: await llamaClient.checkHealth() }))

ipcMain.handle('llama:models', async () => {
  try {
    return fs.readdirSync(MODELS_DIR)
      .filter(f => f.endsWith('.gguf'))
      .map(f => ({ name: f, path: path.join(MODELS_DIR, f) }))
  } catch { return [] }
})

// ── Personality ───────────────────────────────────────────────────────────────
ipcMain.handle('personality:get', async () => readJson(PERSONALITY_FILE, DEFAULT_PERSONALITY))
ipcMain.handle('personality:save', async (_, p) => {
  writeJson(PERSONALITY_FILE, { ...DEFAULT_PERSONALITY, ...p })
  return { success: true }
})

// ── Skills ────────────────────────────────────────────────────────────────────
ipcMain.handle('skills:get', async () => {
  const saved = readJson(SKILLS_FILE, null)
  return saved ?? DEFAULT_SKILLS
})
ipcMain.handle('skills:save', async (_, skills) => {
  writeJson(SKILLS_FILE, skills)
  return { success: true }
})

// ── Quake database ────────────────────────────────────────────────────────────
ipcMain.handle('quakedb:stats',  async () => quakeDb.getDatabaseStats())
ipcMain.handle('quakedb:months', async () => quakeDb.listAvailableMonths())
ipcMain.handle('quakedb:month',  async (_, month) => quakeDb.getMonthStats(month))
ipcMain.handle('quakedb:query',  async (_, { start, end, minMag }) => {
  return quakeDb.queryRange(start, end, minMag ?? 0)
})

// ── History ───────────────────────────────────────────────────────────────────
ipcMain.handle('history:get', async () => readJson(HISTORY_FILE, []))
ipcMain.handle('history:save', async (_, result) => {
  try {
    let h = readJson(HISTORY_FILE, [])
    h.unshift({ ...result, savedAt: new Date().toISOString() })
    if (h.length > 200) h = h.slice(0, 200)
    writeJson(HISTORY_FILE, h)
    return { success: true }
  } catch (e) { return { error: e.message } }
})

// ── Multi-source quake fetch ──────────────────────────────────────────────────
ipcMain.handle('quakes:multi', async (_, { hours = 24, minMag = 0.1, sourceIds }) => {
  try {
    const ids    = sourceIds ?? Object.keys(sources.SOURCES)
    const quakes = await sources.fetchAllSources(hours, minMag, ids)
    if (quakes.length) setImmediate(() => quakeDb.saveQuakes(quakes))
    return { quakes, pattern: sources.analyzePattern(quakes), fetchedAt: new Date().toISOString() }
  } catch (e) { return { error: e.message, quakes: [] } }
})

// ── Statistics ────────────────────────────────────────────────────────────────
ipcMain.handle('stats:live', async (_, { hours = 24, minMag = 0.1, sourceIds }) => {
  try {
    const ids    = sourceIds ?? Object.keys(sources.SOURCES)
    const quakes = await sources.fetchAllSources(hours, minMag, ids)
    if (quakes.length) setImmediate(() => quakeDb.saveQuakes(quakes))
    return statsEngine.computeStats(quakes, { totalHours: hours })
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('stats:db', async (_, { days = 30, minMag = 0 }) => {
  try {
    const start  = new Date(Date.now() - days * 86_400_000).toISOString()
    const end    = new Date().toISOString()
    const quakes = quakeDb.queryRange(start, end, minMag)
    return statsEngine.computeStats(quakes, { totalHours: days * 24 })
  } catch (e) { return { error: e.message } }
})

// ── Swarm / Quake News ────────────────────────────────────────────────────────
ipcMain.handle('swarms:detect', async (_, { hours = 168, minMag = 1.5 } = {}) => {
  try {
    const quakes = await sources.fetchAllSources(hours, minMag, ['usgs', 'emsc', 'ingv', 'nrcan'])
    if (quakes.length) setImmediate(() => quakeDb.saveQuakes(quakes))
    const swarms = swarmDetector.detectSwarms(quakes)
    return { swarms, fetchedAt: new Date().toISOString(), quakeCount: quakes.length }
  } catch (e) { return { error: e.message, swarms: [] } }
})

// List available sources
ipcMain.handle('sources:list', async () => {
  return Object.entries(sources.SOURCES).map(([id, s]) => ({
    id, name: s.name, region: s.region, minMagFloor: s.minMagFloor
  }))
})

// ── Model download ────────────────────────────────────────────────────────────
ipcMain.handle('model:download', async (event, { url, filename }) => {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true })

  const destPath = path.join(MODELS_DIR, filename)

  // Prevent path traversal
  if (!destPath.startsWith(MODELS_DIR)) return { error: 'Invalid filename' }

  const send = (data) => event.sender.send('model:downloadProgress', data)

  return new Promise((resolve) => {
    function doRequest(reqUrl, redirects = 0) {
      if (redirects > 5) { resolve({ error: 'Too many redirects' }); return }

      const parsed = new URL(reqUrl)
      const proto  = parsed.protocol === 'https:' ? https : http

      const req = proto.get(reqUrl, { timeout: 30_000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doRequest(res.headers.location, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          resolve({ error: `HTTP ${res.statusCode}` })
          return
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let received = 0
        let lastPct  = -1

        const file = fs.createWriteStream(destPath)

        res.on('data', chunk => {
          received += chunk.length
          file.write(chunk)
          if (total > 0) {
            const pct = Math.floor((received / total) * 100)
            if (pct !== lastPct) {
              lastPct = pct
              send({ filename, pct, received, total })
            }
          } else {
            send({ filename, pct: -1, received, total: 0 })
          }
        })

        res.on('end', () => {
          file.end()
          resolve({ success: true, path: destPath })
        })

        res.on('error', err => {
          file.destroy()
          fs.unlink(destPath, () => {})
          resolve({ error: err.message })
        })
      })

      req.on('error', err => resolve({ error: err.message }))
      req.on('timeout', ()  => { req.destroy(); resolve({ error: 'Connection timeout' }) })
    }

    doRequest(url)
  })
})

ipcMain.handle('model:cancelDownload', async (_, { filename }) => {
  const destPath = path.join(MODELS_DIR, filename)
  try { fs.unlinkSync(destPath) } catch { /* ok */ }
  return { success: true }
})

ipcMain.handle('model:openFolder', async () => {
  fs.mkdirSync(MODELS_DIR, { recursive: true })
  await shell.openPath(MODELS_DIR)
  return { success: true }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildSystemPrompt(personality) {
  const skills = readJson(SKILLS_FILE, DEFAULT_SKILLS)
  const enabledSkills = skills.filter(s => s.enabled)

  let prompt = personality.systemPrompt || simulation.DEFAULT_SYSTEM_PROMPT
  if (enabledSkills.length > 0) {
    prompt += '\n\nDOMAIN KNOWLEDGE:\n' + enabledSkills.map(s => s.content).join('\n\n')
  }
  return prompt
}
