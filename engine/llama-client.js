'use strict'

const { spawn } = require('child_process')
const path = require('path')

const LLAMA_EXE = path.join(__dirname, '..', 'llama', 'llama-server.exe')
const DEFAULT_PORT = 8080
const HEALTH_POLL_MS = 3_000
const STARTUP_TIMEOUT_MS = 480_000 // 8 min — large 9B models need time on CPU

let serverProcess = null
let currentPort = DEFAULT_PORT

// ── Start ─────────────────────────────────────────────────────────────────────

async function startServer(modelPath, port = DEFAULT_PORT, onLog = null, opts = {}) {
  currentPort = port

  // Kill any stale process first
  await stopServer()

  const ctxSize = opts.ctxSize ?? 4096

  const args = [
    '-m', modelPath,
    '--port', String(port),
    '-c', String(ctxSize),
    '-n', '1024',
    '--temp', '0.3',
    '--repeat-penalty', '1.1',
    '-np', '1',
    '--log-disable'
  ]

  return new Promise((resolve, reject) => {
    serverProcess = spawn(LLAMA_EXE, args, {
      cwd:         path.dirname(LLAMA_EXE),
      windowsHide: false,
      detached:    false
    })

    serverProcess.stdout?.on('data', d => {
      const msg = d.toString().trim()
      if (msg && onLog) onLog(msg.slice(0, 120))
    })

    serverProcess.stderr?.on('data', d => {
      const msg = d.toString().trim()
      if (msg && onLog) onLog(msg.slice(0, 120))
    })

    serverProcess.on('error', err => reject(new Error(`llama-server spawn failed: ${err.message}`)))

    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        serverProcess = null
      }
    })

    // Poll health endpoint until ready or timeout
    const started = Date.now()
    let polling = true
    let lastElapsedLog = 0

    const poll = setInterval(async () => {
      if (!polling) return

      const elapsed = Date.now() - started

      // Report elapsed time every 10s so the UI shows progress
      if (onLog && elapsed - lastElapsedLog >= 10_000) {
        lastElapsedLog = elapsed
        const secs = Math.round(elapsed / 1000)
        onLog(`Loading model... ${secs}s elapsed`)
      }

      if (elapsed > STARTUP_TIMEOUT_MS) {
        polling = false
        clearInterval(poll)
        reject(new Error('Llama server startup timed out after 8 minutes'))
        return
      }

      const healthy = await checkHealth(port)
      if (healthy) {
        polling = false
        clearInterval(poll)
        resolve(true)
      }
    }, HEALTH_POLL_MS)
  })
}

// ── Stop ──────────────────────────────────────────────────────────────────────

async function stopServer() {
  if (!serverProcess) return

  try {
    serverProcess.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 800))
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL')
    }
  } catch { /* process may already be gone */ }

  serverProcess = null
}

// ── Health check ──────────────────────────────────────────────────────────────

async function checkHealth(port = currentPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000)
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Streaming analyze (SSE /v1/chat/completions) ─────────────────────────────

// onToken is called with each streamed token string.
// Returns the full accumulated response when done.
async function streamAnalyze(messages, port = currentPort, onToken = null, samplingParams = {}) {
  const {
    temperature    = 0.25,
    topP           = 0.9,
    topK           = 40,
    repeatPenalty  = 1.1,
    maxTokens      = 1200,
    mirostat       = false,
    mirostatTau    = 5.0,
    mirostatEta    = 0.1
  } = samplingParams

  const body = {
    model:          'local',
    messages,
    temperature,
    top_p:          topP,
    top_k:          topK,
    repeat_penalty: repeatPenalty,
    max_tokens:     maxTokens,
    stream:         true
  }
  if (mirostat) {
    body.mirostat     = 2
    body.mirostat_tau = mirostatTau
    body.mirostat_eta = mirostatEta
  }

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000)
  })

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Llama API error ${res.status}: ${err}`)
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full   = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return full

      try {
        const parsed = JSON.parse(data)
        const token  = parsed.choices?.[0]?.delta?.content ?? ''
        if (token) {
          full += token
          onToken?.(token)
        }
      } catch { /* malformed chunk — skip */ }
    }
  }

  return full
}

// Non-streaming convenience wrapper (used for follow-up chat)
async function analyze(messages, port = currentPort) {
  return streamAnalyze(messages, port, null)
}

module.exports = { startServer, stopServer, checkHealth, analyze, streamAnalyze }
