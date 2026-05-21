const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('QE', {
  // Window
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  // Data collectors
  getQuakeData:    (opts) => ipcRenderer.invoke('quake:getData', opts),
  getSolarData:    ()     => ipcRenderer.invoke('solar:getData'),
  getPlanetaryData:()     => ipcRenderer.invoke('planetary:getData'),

  // Simulation
  runSimulation: (opts)  => ipcRenderer.invoke('simulation:run', opts),

  // Analyst chat
  analystChat: (msgs)   => ipcRenderer.invoke('analyst:chat', { messages: msgs }),

  // Llama server
  startLlama:  (opts)  => ipcRenderer.invoke('llama:start', opts),
  stopLlama:   ()      => ipcRenderer.invoke('llama:stop'),
  llamaStatus: ()      => ipcRenderer.invoke('llama:status'),
  listModels:  ()      => ipcRenderer.invoke('llama:models'),

  // Personality
  getPersonality:  ()  => ipcRenderer.invoke('personality:get'),
  savePersonality: (p) => ipcRenderer.invoke('personality:save', p),

  // Skills
  getSkills:  ()       => ipcRenderer.invoke('skills:get'),
  saveSkills: (skills) => ipcRenderer.invoke('skills:save', skills),

  // Quake database
  dbStats:    ()                     => ipcRenderer.invoke('quakedb:stats'),
  dbMonths:   ()                     => ipcRenderer.invoke('quakedb:months'),
  dbMonth:    (m)                    => ipcRenderer.invoke('quakedb:month', m),
  dbQuery:    (start, end, minMag)   => ipcRenderer.invoke('quakedb:query', { start, end, minMag }),

  // History
  getHistory:  ()      => ipcRenderer.invoke('history:get'),
  saveHistory: (r)     => ipcRenderer.invoke('history:save', r),

  // Multi-source quake fetch
  getMultiQuakes: (o)  => ipcRenderer.invoke('quakes:multi', o),

  // Statistics
  statsLive: (o)       => ipcRenderer.invoke('stats:live', o),
  statsDb:   (o)       => ipcRenderer.invoke('stats:db',   o),

  // Swarm / Quake News
  detectSwarms: (o)    => ipcRenderer.invoke('swarms:detect', o),

  // Source list
  listSources: ()      => ipcRenderer.invoke('sources:list'),

  // Model download & folder
  downloadModel:       (url, filename) => ipcRenderer.invoke('model:download', { url, filename }),
  cancelModelDownload: (filename)      => ipcRenderer.invoke('model:cancelDownload', { filename }),
  openModelsFolder:    ()              => ipcRenderer.invoke('model:openFolder'),

  // Open URL in default browser
  openExternal: (url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      ipcRenderer.send('shell:open', url)
    }
  },

  // IPC event bus
  on:  (ch, cb) => ipcRenderer.on(ch,  (_, d) => cb(d)),
  off: (ch, cb) => ipcRenderer.off(ch, cb)
})
