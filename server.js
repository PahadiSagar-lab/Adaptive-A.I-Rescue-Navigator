const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'map.json');
const ENGINE = path.join(__dirname, process.platform === 'win32' ? 'rescue_engine.exe' : 'rescue_engine');

const seed = {
  locations: ['RescueCenter', 'Hospital', 'ISBT', 'ClementTown', 'DisasterZone'],
  roads: [
    ['RescueCenter', 'Hospital', 4, false],
    ['RescueCenter', 'ISBT', 6, false],
    ['Hospital', 'ClementTown', 3, false],
    ['ISBT', 'ClementTown', 2, false],
    ['ClementTown', 'DisasterZone', 5, false]
  ]
};

let map;
try {
  map = JSON.parse(fs.readFileSync(DB, 'utf8'));
  if (!Array.isArray(map.locations) || !Array.isArray(map.roads)) throw new Error('Invalid map file');
} catch {
  map = JSON.parse(JSON.stringify(seed));
  save();
}

function save() {
  fs.writeFileSync(DB, JSON.stringify(map, null, 2));
}

/*
 * Persistent C process. Every API operation is forwarded to this process;
 * JavaScript keeps only the serializable map snapshot used by the UI.
 */
class CEngine {
  constructor(executable) {
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = [];
    this.closed = false;

    const output = readline.createInterface({ input: this.child.stdout });
    output.on('line', line => {
      const request = this.pending.shift();
      if (!request) return;
      try {
        const result = JSON.parse(line);
        if (!result.ok) request.reject(new Error(result.error || 'C engine rejected the command.'));
        else request.resolve(result);
      } catch (error) {
        request.reject(new Error(`Invalid response from C engine: ${line}`));
      }
    });

    this.child.stderr.on('data', chunk => process.stderr.write(`[C engine] ${chunk}`));
    this.child.on('error', error => this.failAll(error));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`C engine stopped (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).`));
    });
  }

  call(command) {
    if (this.closed) return Promise.reject(new Error('C engine is not running.'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(command) + '\n', error => {
        if (error) {
          const index = this.pending.findIndex(item => item.resolve === resolve);
          if (index >= 0) this.pending.splice(index, 1);
          reject(error);
        }
      });
    });
  }

  failAll(error) {
    while (this.pending.length) this.pending.shift().reject(error);
  }
}

const engine = new CEngine(ENGINE);

async function rebuildEngineFromMap() {
  await engine.call({ command: 'init' });
  for (const name of map.locations) {
    await engine.call({ command: 'addLocation', name });
  }
  for (const [from, to, cost, blocked] of map.roads) {
    await engine.call({ command: 'addRoad', from, to, cost });
    if (blocked) await engine.call({ command: 'blockRoad', from, to });
  }
}

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function publicError(res, error, status = 400) {
  send(res, status, { error: error.message || String(error) });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;
  let data = {};

  if (req.method !== 'GET') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) throw new Error('Request body is too large.');
    }
    try { data = JSON.parse(body || '{}'); }
    catch { return send(res, 400, { error: 'Invalid JSON request body.' }); }
  }

  try {
    if (route === '/api/map' && req.method === 'GET') {
      const liveMap = await engine.call({ command: 'displayMap' });
      return send(res, 200, { locations: liveMap.locations, roads: liveMap.roads });
    }

    if (route === '/api/route' && req.method === 'POST') {
      const result = await engine.call({
        command: 'findRoute',
        source: String(data.source || ''),
        destination: String(data.destination || '')
      });
      if (!result.found) {
        return send(res, 200, {
          reachable: false,
          source: data.source,
          destination: data.destination
        });
      }
      return send(res, 200, {
        reachable: true,
        path: result.route,
        cost: result.totalCost,
        minutes: result.estimatedTimeMinutes,
        source: data.source,
        destination: data.destination
      });
    }

    if (route === '/api/location' && req.method === 'POST') {
      const name = String(data.name || '').trim();
      if (!name || name.length > 29) throw new Error('Name must be 1–29 characters.');
      if (map.locations.length >= 20) throw new Error('Map limit is 20 locations.');
      if (map.locations.includes(name)) throw new Error('Location already exists.');
      await engine.call({ command: 'addLocation', name });
      map.locations.push(name);
      save();
      return send(res, 200, map);
    }

    if (route === '/api/road' && req.method === 'POST') {
      const from = String(data.from || '');
      const to = String(data.to || '');
      const cost = Number(data.cost);
      if (!map.locations.includes(from) || !map.locations.includes(to) || from === to)
        throw new Error('Choose two different valid locations.');
      if (!Number.isInteger(cost) || cost < 1 || cost >= 9999)
        throw new Error('Road cost must be 1–9998.');

      const old = map.roads.find(r =>
        (r[0] === from && r[1] === to) || (r[0] === to && r[1] === from));
      if (old && old[3]) await engine.call({ command: 'unblockRoad', from: old[0], to: old[1] });
      await engine.call({ command: 'addRoad', from, to, cost });

      if (old) {
        old[0] = from; old[1] = to; old[2] = cost; old[3] = false;
      } else {
        map.roads.push([from, to, cost, false]);
      }
      save();
      return send(res, 200, map);
    }

    if (route === '/api/block' && req.method === 'POST') {
      const from = String(data.from || '');
      const to = String(data.to || '');
      const road = map.roads.find(r =>
        (r[0] === from && r[1] === to) || (r[0] === to && r[1] === from));
      if (!road) throw new Error('No direct road exists.');
      const command = road[3] ? 'unblockRoad' : 'blockRoad';
      await engine.call({ command, from: road[0], to: road[1] });
      road[3] = !road[3];
      save();
      return send(res, 200, { map, blocked: road[3] });
    }

    if (route === '/api/reset' && req.method === 'POST') {
      map = JSON.parse(JSON.stringify(seed));
      await rebuildEngineFromMap();
      save();
      return send(res, 200, map);
    }

    return send(res, 404, { error: 'API route not found.' });
  } catch (error) {
    return publicError(res, error);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  if (req.url.startsWith('/api/')) {
    return handleApi(req, res).catch(error => publicError(res, error, 500));
  }

  const requested = req.url.split('?')[0];
  const file = requested === '/' ? '/index.html' : requested;
  const publicRoot = path.join(__dirname, 'public');
  const full = path.resolve(publicRoot, `.${path.normalize(file)}`);
  if (!full.startsWith(publicRoot + path.sep) && full !== publicRoot)
    return send(res, 403, { error: 'Forbidden' });

  fs.readFile(full, (error, content) => {
    if (error) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const extension = path.extname(full);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream' });
    res.end(content);
  });
});

(async () => {
  try {
    await rebuildEngineFromMap();
    server.listen(PORT, () => {
      console.log(`Rescue Navigator running at http://localhost:${PORT}`);
      console.log('Runtime engine: original C implementation');
    });
  } catch (error) {
    console.error(`Unable to initialize C rescue engine: ${error.message}`);
    console.error('Compile it first: gcc -std=c99 -O2 rescue_adapter.c -o rescue_engine');
    process.exit(1);
  }
})();

process.on('SIGINT', () => {
  engine.child.kill();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  engine.child.kill();
  server.close(() => process.exit(0));
});
