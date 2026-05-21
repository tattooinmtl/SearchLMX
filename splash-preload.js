const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('SPLASH', {
  ready:      ()   => ipcRenderer.send('splash:ready'),
  onSysInfo:  (cb) => ipcRenderer.on('splash:sysinfo', (_, d) => cb(d)),
  onStep:     (cb) => ipcRenderer.on('splash:step',    (_, d) => cb(d)),
  onDone:     (cb) => ipcRenderer.on('splash:done',    ()     => cb())
})
