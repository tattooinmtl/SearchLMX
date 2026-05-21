# SearchLMx — Earthquake Monitoring & AI Analysis Engine

A local-first, open-source Electron desktop app for real-time global earthquake monitoring, seismic statistics, swarm detection, live station waveforms, and AI-powered analysis — all running on your own machine with no cloud subscriptions.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-latest-47848F)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

### Live Data
| Panel | What it shows |
|-------|--------------|
| **Dashboard** | Global quake map + real-time feed from up to 6 networks simultaneously |
| **Quake Feed** | Filterable live event list with magnitude, depth, region, and source |
| **Solar Monitor** | NOAA SWPC live X-ray flux, Kp index, solar wind speed/density, IMF Bz |
| **Planetary & Tidal** | Lunar phase, tidal stress, planetary positions, 5-factor seismic risk score |
| **Statistics** | Magnitude distribution, hourly/daily time series, source breakdown, depth bins |
| **Quake News** | Automatic swarm and aftershock sequence detection across 4 global networks |
| **Live Stations** | Real-time MiniSEED waveform viewer for 6 FDSN data centers |

### AI Analysis
- Local LLM integration via [llama.cpp](https://github.com/ggerganov/llama-cpp) — no API keys, no data sent to the cloud
- **Run Simulation**: feeds live quake + solar + tidal data into the model and generates a structured seismic risk assessment
- **Analyst Chat**: follow-up Q&A with full conversation context retained
- Configurable sampling parameters (temperature, top-p, top-k, repeat penalty, Mirostat)
- Streaming token output with live token/s counter
- Switchable models at runtime — start light, upgrade to a larger model when needed

### Settings
- **Download Models**: one-click download of 8 curated CPU-optimized GGUF models from HuggingFace
- **Skills**: inject domain knowledge blocks into the system prompt (seismology, solar physics, tidal mechanics, statistical analysis)
- **Analyst Profile**: fully customizable system prompt and all sampling parameters
- **Local Database**: quakes auto-saved month-by-month; supports date-range queries back across your full history

---

## Seismic Data Sources

| ID | Network | Region | Min Mag |
|----|---------|--------|---------|
| USGS | US Geological Survey | Global | M0+ |
| EMSC | European-Mediterranean Seismological Centre | Europe / Global | M3.5+ |
| INGV | Istituto Nazionale di Geofisica e Vulcanologia | Italy | M0+ |
| NRCan | Earthquakes Canada | Canada | M0+ |
| GFZ | GeoForschungsZentrum Potsdam | Europe / Global | M3+ |
| NCEDC | Northern California Earthquake Data Center | N. California | M0+ |

Duplicate events from multiple networks are automatically merged using spatial-temporal matching (< 25 km, < 90 s).

---

## Live Station Waveforms

Connects directly to FDSN dataselect services. Supports 6 data centers:

- **EarthScope** (USGS Global, IRIS/IDA, GEOSCOPE, US National, Alaska)
- **Canada NRCan** (Canadian National Network)
- **NCEDC** (N. California, Berkeley, Nevada)
- **SCEDC** (S. California, Arizona)
- **INGV** (Italy, MedNet)
- **GFZ / GEOFON** (Germany, BATS Taiwan)

Channel priority: BHZ → HHZ → EHZ → SHZ → LHZ. Streams auto-update every 10 seconds. Decodes MiniSEED encoding types: Steim-1, Steim-2, INT16/32, FLOAT32/64.

---

## Recommended Models

All models are Q4_K_M GGUF quantization — best CPU quality/speed ratio. Download from the **Settings → Download Models** tab inside the app.

| Model | Size | Best for |
|-------|------|----------|
| Llama 3.2 1B Instruct | 0.8 GB | Ultra-fast, very low RAM |
| Gemma 2 2B Instruct | 1.6 GB | Fast, efficient, good quality |
| Llama 3.2 3B Instruct *(default)* | 2.0 GB | Best balance for most systems |
| Phi-3.5 Mini Instruct (3.8B) | 2.2 GB | Strong reasoning for its size |
| Mistral 7B Instruct v0.3 | 4.1 GB | Classic high-quality model |
| Qwen 2.5 7B Instruct | 4.1 GB | Excellent structured analysis |
| DeepSeek R1 Distill 7B | 4.3 GB | Chain-of-thought reasoning |
| Llama 3.1 8B Instruct | 4.9 GB | Best overall quality |

> **Large models (7B+):** Use **2048 context** in the Load dialog to keep RAM usage under 10 GB. Load time on CPU is 3–8 minutes — the sidebar shows elapsed seconds.

---

## Requirements

- **Windows 10/11** (64-bit)
- **Node.js** 18+
- **8 GB RAM** minimum (16 GB recommended for 7B+ models)
- CPU with AVX2 support (most Intel/AMD CPUs from 2015+)
- Internet connection for live data feeds

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/tattooinmtl/SearchLMX.git
cd SearchLMX

# 2. Install dependencies
npm install

# 3. Add llama-server
#    Download a llama.cpp release for Windows from:
#    https://github.com/ggerganov/llama.cpp/releases
#    Extract llama-server.exe into the llama/ folder

# 4. Add a model
#    Place any .gguf file in the Models/ folder, or use
#    Settings → Download Models inside the app to download one.

# 5. Run
npm start

# Development mode (opens DevTools)
npm run dev
```

### Folder structure after setup

```
SearchLMX/
├── engine/          # Data fetchers, AI client, algorithm
├── renderer/        # UI (HTML, CSS, JS)
├── llama/
│   └── llama-server.exe   ← you add this
├── Models/
│   └── Llama-3.2-3B-Instruct-Q4_K_M.gguf   ← you add this
├── data/            # Auto-created: history.json, personality.json, quake DB
├── main.js
├── preload.js
└── package.json
```

---

## Starting the Server

The app has a built-in **Start Server** button in the sidebar. On first launch it will load the default model from the `Models/` folder.

To pre-start the server with the lightweight 3B model before opening the app, you can also run:

```bat
start-servers.bat
```

To switch to a larger model at runtime: **Settings → AI Models** → select model → set context size → **Load**.

---

## Architecture

```
Electron Main Process (main.js)
├── IPC handlers for all external API calls
├── llama-server.exe lifecycle management
├── Local quake database (JSON, month shards)
└── Model download streaming

Renderer Process
├── app.js       — UI logic, charts (Chart.js), map (Leaflet)
├── stations.js  — MiniSEED fetching and waveform rendering
└── index.html / styles.css

Engine Modules (Node.js)
├── sources.js       — Multi-network FDSN quake fetcher + deduplication
├── solar.js         — NOAA SWPC solar weather
├── planetary.js     — Astronomy-engine tidal/planetary positions
├── algorithm.js     — 5-factor seismic risk scoring
├── simulation.js    — AI prompt assembly + llama-client orchestration
├── llama-client.js  — llama-server HTTP client (streaming SSE)
├── quake-db.js      — Local JSON database with month-by-month sharding
├── stats-engine.js  — Pure statistics computation
└── swarm-detector.js — Anchor-based spatial-temporal clustering
```

---

## Data Privacy

All processing is local. The app:
- Fetches public, free APIs (USGS, NOAA, EMSC, etc.) directly from your machine
- Stores history in `data/` on your local drive
- Runs the AI model entirely on your CPU — no text is sent to any external service
- Requires no accounts, API keys, or subscriptions

---

## Contributing

Pull requests welcome. Key areas for improvement:
- Additional seismic network sources (JMA Japan, AFAD Turkey, GeoNet NZ)
- MiniSEED3 format support in the waveform viewer
- Earthquake early warning integration (ShakeAlert)
- Export to CSV / GeoJSON
- macOS / Linux packaging

---

## License

MIT — free to use, modify, and distribute.

---

*Built with Electron, llama.cpp, Leaflet, Chart.js, and public open-data APIs from USGS, NOAA, EMSC, INGV, NRCan, GFZ, NCEDC, and EarthScope.*
