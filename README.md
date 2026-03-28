# ⛏ CreeperHost  —  Flask + Electron Edition

Host Minecraft with your friends. The Python backend runs a Flask/SocketIO server; Electron wraps it as a native desktop app.

---

## Architecture

```
┌─────────────────────────────────────┐
│           Electron (Node)           │  ← native window, file dialogs
│  ┌───────────────────────────────┐  │
│  │   BrowserWindow (Chromium)    │  │  ← HTML/CSS/JS frontend
│  │   localhost:PORT              │  │
│  └───────────────────────────────┘  │
│           spawns ↓                  │
│  ┌───────────────────────────────┐  │
│  │   Python  backend/run.py      │  │  ← Flask + SocketIO
│  │   REST API  +  WebSockets     │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Python | 3.10+ | Must be on PATH |
| Node.js | 18+ | https://nodejs.org |
| Java | 17+ (21 recommended) | For running MC server |

---

## Quick Start

### 1 — Install Python dependencies

```bash
cd creeperhost
pip install -r backend/requirements.txt
```

### 2 — Install Node dependencies

```bash
npm install
```

### 3 — Run in development mode

**Option A — Electron (full desktop app):**
```bash
npm start
```
Electron will spawn the Flask backend automatically and open the window.

**Option B — Flask only (browser):**
```bash
cd creeperhost
python backend/run.py --port 5150
# Then open http://localhost:5150 in your browser
```

---

## Project Structure

```
creeperhost/
├── package.json               ← Electron / npm config
├── electron/
│   ├── main.js                ← Electron main process
│   │                            spawns Flask, creates window
│   └── preload.js             ← Secure IPC bridge to renderer
│
├── frontend/
│   ├── templates/
│   │   └── index.html         ← Single-page app shell
│   └── static/
│       ├── css/main.css       ← Full light theme stylesheet
│       └── js/
│           ├── api.js         ← REST API wrappers
│           ├── ui.js          ← DOM manipulation helpers
│           └── app.js         ← App logic + SocketIO events
│
└── backend/
    ├── run.py                 ← Entry point (spawned by Electron)
    ├── app.py                 ← Flask factory + SocketIO init
    ├── state.py               ← Shared singleton app state
    ├── requirements.txt
    │
    ├── api/
    │   ├── settings_api.py    ← GET/POST /api/settings
    │   ├── group_api.py       ← /api/group  (peers, chat, election)
    │   ├── server_api.py      ← /api/server (start, stop, log, download)
    │   └── benchmark_api.py   ← /api/benchmark
    │
    ├── config/
    │   └── settings.py        ← Constants, JSON config load/save
    ├── network/
    │   ├── peer.py            ← TCP peer messaging + heartbeat
    │   └── group.py           ← Friend list, host election, failover
    ├── server/
    │   ├── manager.py         ← MC server subprocess lifecycle
    │   └── downloader.py      ← Mojang JAR fetcher
    └── utils/
        ├── benchmark.py       ← CPU/RAM/disk/network scoring
        ├── backup.py          ← World snapshots + AutoBackup
        └── logger.py          ← File + event logger
```

---

## Real-time Events (SocketIO)

The frontend subscribes to these events emitted by the backend:

| Event | Payload | Description |
|---|---|---|
| `server_log` | `{line}` | New MC console line |
| `server_status` | `{status}` | Status changed (running/stopped/crashed…) |
| `players` | `{players:[]}` | Player list updated |
| `peers_update` | — | Friend list changed, re-fetch |
| `host_changed` | `{host}` | New host elected |
| `chat` | `{sender,text,ts}` | Incoming chat message |
| `bench_progress` | `{label,pct}` | Benchmark step update |
| `bench_done` | result dict | Benchmark complete |
| `download_progress` | `{pct,done_mb,total_mb}` | JAR download progress |
| `download_done` | `{ok,path}` | JAR download complete |

---

## REST API Reference

### Settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings/` | Get all settings |
| `POST` | `/api/settings/` | Save settings (username, ram, etc.) |
| `GET` | `/api/settings/ip` | Get local IP address |

### Group
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/group/peers` | List all peers + self |
| `POST` | `/api/group/peers` | Add a friend `{username, ip}` |
| `DELETE` | `/api/group/peers/:name` | Remove a friend |
| `POST` | `/api/group/elect` | Elect best host |
| `GET` | `/api/group/chat` | Chat history |
| `POST` | `/api/group/chat` | Send chat message `{text}` |

### Server
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/server/status` | Status + CPU/RAM/PID/players |
| `GET` | `/api/server/log` | Full console log |
| `POST` | `/api/server/start` | Start server `{jar_path, ram_mb, threads, java_path}` |
| `POST` | `/api/server/stop` | Stop server |
| `POST` | `/api/server/command` | Send console command `{command}` |
| `POST` | `/api/server/backup` | Trigger world backup |
| `GET` | `/api/server/versions` | Fetch MC versions from Mojang |
| `POST` | `/api/server/download` | Download JAR `{meta_url, dest}` |

### Benchmark
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/benchmark/run` | Start benchmark (results via SocketIO) |
| `GET` | `/api/benchmark/result` | Get last result |

---

## Networking

### LAN (same network)
Works out of the box. Friends add each other by local IP (e.g. `192.168.1.x`).

### Internet play (different networks)
Pick one approach:

**ZeroTier / Tailscale (easiest):**
Install on all machines → creates a virtual LAN → use the virtual IP.

**Port forwarding:**
Forward TCP `25566` (discovery) and `25565` (Minecraft) on the host's router.
Friends use the host's public IP.

**Relay (advanced):**
See `backend/network/peer.py → RelayClient` stub for WebSocket relay implementation.

---

## Building a Distributable (.exe)

```bash
# Package the Electron app (Windows)
npm run package
# Output: dist/CreeperHost Setup x.x.x.exe
```

> **Note:** For a fully self-contained installer you'll also need to bundle Python.
> Options: PyInstaller to compile `backend/run.py` into an `.exe`, then reference
> that in `electron/main.js` instead of calling `python run.py`.
> See `electron/main.js → getPythonPath()` — it already checks for a bundled exe.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Module not found: flask` | Run `pip install -r backend/requirements.txt` |
| Flask port conflict | Electron auto-picks a free port; if running manually, try `--port 5151` |
| Blank window in Electron | Check terminal for Flask startup errors; try `npm run dev` for DevTools |
| Friends show offline | Check firewall allows TCP on port `25566` |
| Java version error | Set full path to `java.exe` in the Java Executable field |
| `ENOENT: electron` | Run `npm install` first |

---

*Python · Flask · SocketIO · Electron · Vanilla JS*
