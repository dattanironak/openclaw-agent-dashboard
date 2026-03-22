const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const PORT = Number(process.env.PORT || 3477);
const HOST = process.env.HOST || '127.0.0.1';
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(APP_DIR, 'data');
const PROFILES_PATH = path.join(DATA_DIR, 'agent-profiles.json');
const TRACKED_AGENTS_PATH = path.join(DATA_DIR, 'tracked-agents.json');
const streamClients = new Set();

const DEFAULT_PROFILES = [
  {
    id: 'main',
    label: 'Main agent',
    targetAgentId: 'main',
    defaultThinking: 'low',
    notes: 'Default OpenClaw agent'
  }
];

const DEFAULT_TRACKED_AGENTS = [
  {
    id: 'main',
    label: 'Main agent',
    notes: 'Default tracked OpenClaw agent'
  }
];

async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(PROFILES_PATH, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(PROFILES_PATH, JSON.stringify(DEFAULT_PROFILES, null, 2));
  }
  try {
    await fsp.access(TRACKED_AGENTS_PATH, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(TRACKED_AGENTS_PATH, JSON.stringify(DEFAULT_TRACKED_AGENTS, null, 2));
  }
}

function execOpenClaw(args, options = {}) {
  return new Promise((resolve) => {
    execFile('openclaw', args, { timeout: options.timeout || 20000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
        error: error ? String(error.message || error) : null,
      });
    });
  });
}

function execShell(command, timeout = 12000) {
  return new Promise((resolve) => {
    require('child_process').exec(command, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
        error: error ? String(error.message || error) : null,
      });
    });
  });
}

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readJsonFile(filePath, fallback) {
  await ensureDataFiles();
  const raw = await fsp.readFile(filePath, 'utf8');
  return parseJsonSafe(raw, fallback);
}

async function writeJsonFile(filePath, value) {
  await ensureDataFiles();
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function getProfiles() {
  return readJsonFile(PROFILES_PATH, DEFAULT_PROFILES);
}

async function saveProfiles(profiles) {
  await writeJsonFile(PROFILES_PATH, profiles);
}

async function getTrackedAgents() {
  return readJsonFile(TRACKED_AGENTS_PATH, DEFAULT_TRACKED_AGENTS);
}

async function saveTrackedAgents(agents) {
  await writeJsonFile(TRACKED_AGENTS_PATH, agents);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function normalizeProfiles(profiles) {
  const seen = new Set();
  return profiles.map((profile) => ({
    id: String(profile.id || '').trim(),
    label: String(profile.label || '').trim(),
    targetAgentId: String(profile.targetAgentId || '').trim(),
    defaultThinking: String(profile.defaultThinking || 'low').trim() || 'low',
    notes: String(profile.notes || '').trim(),
  })).filter((profile) => {
    if (!profile.id || !profile.label || !profile.targetAgentId || seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
}

function normalizeTrackedAgents(items) {
  const seen = new Set();
  return items.map((item) => ({
    id: String(item.id || '').trim(),
    label: String(item.label || '').trim(),
    notes: String(item.notes || '').trim(),
  })).filter((item) => {
    if (!item.id || !item.label || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function getGatewayStatus() {
  const result = await execOpenClaw(['gateway', 'status'], { timeout: 12000 });
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return {
    ok: result.ok,
    raw: text,
    summary: text || (result.ok ? 'No output' : 'Unavailable')
  };
}

async function getHostStats() {
  const meminfo = await execShell("free -b | awk 'NR==2 {print $2, $3, $4, $7} NR==3 {print $2, $3, $4}'", 5000);
  const disk = await execShell("df -B1 / | awk 'NR==2 {print $2, $3, $4, $5}'", 5000);
  const load = os.loadavg();

  let memory = null;
  if (meminfo.ok) {
    const lines = meminfo.stdout.split('\n');
    const ram = lines[0]?.split(/\s+/).map(Number) || [];
    const swap = lines[1]?.split(/\s+/).map(Number) || [];
    memory = {
      ram: { total: ram[0] || 0, used: ram[1] || 0, free: ram[2] || 0, available: ram[3] || 0 },
      swap: { total: swap[0] || 0, used: swap[1] || 0, free: swap[2] || 0 }
    };
  }

  let rootDisk = null;
  if (disk.ok) {
    const parts = disk.stdout.split(/\s+/);
    rootDisk = {
      total: Number(parts[0] || 0),
      used: Number(parts[1] || 0),
      free: Number(parts[2] || 0),
      usePercent: parts[3] || '0%'
    };
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: os.uptime(),
    loadAverage: load,
    memory,
    rootDisk
  };
}

function buildAgentPerformance(trackedAgents, sessions) {
  const byId = new Map();
  for (const agent of trackedAgents) {
    byId.set(agent.id, {
      id: agent.id,
      label: agent.label,
      notes: agent.notes || '',
      existsInSessions: false,
      sessionCount: 0,
      activeLastHour: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      models: [],
      lastUpdatedAt: null,
      lastKind: null,
      avgTokensPerSession: 0,
      health: 'idle',
    });
  }

  for (const session of sessions) {
    const agentId = session.agentId || 'unknown';
    if (!byId.has(agentId)) {
      byId.set(agentId, {
        id: agentId,
        label: agentId,
        notes: 'Discovered from sessions',
        existsInSessions: false,
        sessionCount: 0,
        activeLastHour: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: [],
        lastUpdatedAt: null,
        lastKind: null,
        avgTokensPerSession: 0,
        health: 'idle',
      });
    }
    const item = byId.get(agentId);
    item.existsInSessions = true;
    item.sessionCount += 1;
    item.totalTokens += Number(session.totalTokens || 0);
    item.inputTokens += Number(session.inputTokens || 0);
    item.outputTokens += Number(session.outputTokens || 0);
    if (session.model && !item.models.includes(session.model)) item.models.push(session.model);
    if (!item.lastUpdatedAt || Number(session.updatedAt || 0) > Number(item.lastUpdatedAt || 0)) {
      item.lastUpdatedAt = session.updatedAt || null;
      item.lastKind = session.kind || null;
    }
    if (Number(session.ageMs || Infinity) <= 60 * 60 * 1000) item.activeLastHour += 1;
  }

  return Array.from(byId.values()).map((item) => {
    item.avgTokensPerSession = item.sessionCount ? Math.round(item.totalTokens / item.sessionCount) : 0;
    if (!item.existsInSessions) item.health = 'not-seen';
    else if (item.activeLastHour > 0) item.health = 'active';
    else item.health = 'idle';
    return item;
  }).sort((a, b) => {
    const ta = Number(a.lastUpdatedAt || 0);
    const tb = Number(b.lastUpdatedAt || 0);
    return tb - ta || a.id.localeCompare(b.id);
  });
}

async function getOverview() {
  const [statusRaw, sessionsRaw, gateway, hostStats, trackedAgents] = await Promise.all([
    execOpenClaw(['status', '--json']),
    execOpenClaw(['sessions', '--all-agents', '--json']),
    getGatewayStatus(),
    getHostStats(),
    getTrackedAgents(),
  ]);

  const status = parseJsonSafe(statusRaw.stdout, {});
  const sessions = parseJsonSafe(sessionsRaw.stdout, {});
  const allSessions = Array.isArray(sessions.sessions) ? sessions.sessions : [];
  const recent = allSessions.slice(0, 8);
  const agentPerformance = buildAgentPerformance(trackedAgents, allSessions);

  return {
    generatedAt: new Date().toISOString(),
    openclawVersion: status.runtimeVersion || null,
    defaultAgentId: status.heartbeat?.defaultAgentId || null,
    configuredHeartbeatAgents: status.heartbeat?.agents || [],
    channelSummary: status.channelSummary || [],
    gateway,
    hostStats,
    sessions: {
      count: sessions.count || status.sessions?.count || 0,
      recent,
      stores: sessions.stores || [],
    },
    agents: {
      tracked: trackedAgents,
      performance: agentPerformance,
    },
    rawStatusAvailable: statusRaw.ok,
    rawSessionsAvailable: sessionsRaw.ok,
  };
}

async function getStreamPayload() {
  const [overview, trackedAgents] = await Promise.all([
    getOverview(),
    getTrackedAgents(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    overview,
    trackedAgents,
  };
}

async function pushStreamUpdate() {
  if (!streamClients.size) return;
  try {
    const payload = JSON.stringify(await getStreamPayload());
    for (const client of streamClients) {
      client.write(`data: ${payload}\n\n`);
    }
  } catch {
    // ignore transient CLI failures; next refresh tick can recover
  }
}

setInterval(() => {
  pushStreamUpdate();
}, 5000).unref();

async function dispatchTask(payload) {
  const targetAgentId = String(payload.targetAgentId || '').trim();
  const message = String(payload.message || '').trim();
  const thinking = String(payload.thinking || '').trim();

  if (!targetAgentId || !message) {
    return { ok: false, error: 'targetAgentId and message are required' };
  }

  const args = ['agent', '--agent', targetAgentId, '--message', message];
  if (thinking) args.push('--thinking', thinking);

  const result = await execOpenClaw(args, { timeout: 30000 });
  return {
    ok: result.ok,
    command: ['openclaw', ...args].join(' '),
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

async function serveStatic(req, res) {
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  urlPath = urlPath.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^([.][.][/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handler(req, res) {
  try {
    if (req.method === 'GET' && req.url.startsWith('/api/overview')) {
      return sendJson(res, 200, await getOverview());
    }
    if (req.method === 'GET' && req.url.startsWith('/api/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify(await getStreamPayload())}\n\n`);
      streamClients.add(res);
      req.on('close', () => streamClients.delete(res));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/profiles')) {
      return sendJson(res, 200, { items: await getProfiles() });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/profiles')) {
      const body = await readBody(req);
      const profiles = normalizeProfiles([...(await getProfiles()), body]);
      await saveProfiles(profiles);
      await pushStreamUpdate();
      return sendJson(res, 201, { ok: true, items: profiles });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/profiles/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const profiles = (await getProfiles()).filter((p) => p.id !== id);
      await saveProfiles(profiles);
      await pushStreamUpdate();
      return sendJson(res, 200, { ok: true, items: profiles });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/agents')) {
      return sendJson(res, 200, { items: await getTrackedAgents() });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/agents')) {
      const body = await readBody(req);
      const items = normalizeTrackedAgents([...(await getTrackedAgents()), body]);
      await saveTrackedAgents(items);
      await pushStreamUpdate();
      return sendJson(res, 201, { ok: true, items });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/agents/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const items = (await getTrackedAgents()).filter((p) => p.id !== id);
      await saveTrackedAgents(items);
      await pushStreamUpdate();
      return sendJson(res, 200, { ok: true, items });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/tasks')) {
      const body = await readBody(req);
      const result = await dispatchTask(body);
      await pushStreamUpdate();
      return sendJson(res, 200, result);
    }
    return serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, { error: String(error.message || error) });
  }
}

ensureDataFiles().then(() => {
  http.createServer(handler).listen(PORT, HOST, () => {
    console.log(`OpenClaw local dashboard running at http://${HOST}:${PORT}`);
  });
});
