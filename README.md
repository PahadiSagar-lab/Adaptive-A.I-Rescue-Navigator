# Adaptive AI Rescue Navigator — C Runtime Web App

This version keeps the existing dark web dashboard and makes the **original C implementation the runtime engine** for map operations and shortest-safe-route calculations.

## Requirements

- Node.js 18 or newer
- GCC C compiler (for Windows, install a MinGW-w64 / MSYS2 GCC toolchain and ensure `gcc` is on PATH)

There are no npm package dependencies.

## Build the C engine

Open a terminal in this project folder (the folder containing `server.js`).

**Windows (PowerShell or CMD):**

```powershell
gcc -std=c99 -O2 rescue_adapter.c -o rescue_engine.exe
```

**Linux / macOS:**

```bash
gcc -std=c99 -O2 rescue_adapter.c -o rescue_engine
```

The adapter includes `src/rescue.c`; keep the folder structure unchanged.

## Start the web app

```bash
npm start
```

If PowerShell blocks `npm.ps1` with an execution-policy error, use:

```powershell
npm.cmd start
```

Then open [http://localhost:3000](http://localhost:3000).

## How the integration works

```text
Browser UI  <-->  Node.js HTTP API  <-->  Persistent C executable
                                      |
                                      +-- initializeMap()
                                      +-- addLocation()
                                      +-- addRoad()
                                      +-- blockRoad()
                                      +-- minDistance() / Dijkstra route calculation
                                      +-- displayMap data
```

- The C process stays alive while the Node server runs, so its `RescueMap` remains in memory.
- Node sends one JSON command per line to the C process and receives one JSON response per line.
- The Node API keeps `map.json` as a persistence snapshot and rebuilds the C map from it on startup.
- The C engine is used for adding locations, adding roads, blocking/unblocking roads, reading the live map, and calculating routes.
- The UI and its existing API paths are preserved.

## Existing API

- `GET /api/map`
- `POST /api/route` — `{ "source": "RescueCenter", "destination": "DisasterZone" }`
- `POST /api/location` — `{ "name": "FireStation" }`
- `POST /api/road` — `{ "from": "RescueCenter", "to": "FireStation", "cost": 4 }`
- `POST /api/block` — `{ "from": "RescueCenter", "to": "Hospital" }` (toggles blocked / active)
- `POST /api/reset`

## JSON command-line adapter

The C executable accepts one JSON object per input line. Example commands:

```json
{"command":"addLocation","name":"Hospital"}
{"command":"addLocation","name":"Shelter"}
{"command":"addRoad","from":"Hospital","to":"Shelter","cost":5}
{"command":"findRoute","source":"Hospital","destination":"Shelter"}
```

A successful route response looks like:

```json
{"ok":true,"found":true,"route":["Hospital","Shelter"],"totalCost":5,"estimatedTimeMinutes":10}
```

The adapter also supports `init`, `blockRoad`, `unblockRoad`, `displayMap`, and `exit`.
