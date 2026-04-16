require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { readConfig, writeConfig, buildSearchTargets } = require('./lib/filters');

const app = express();
const PORT = Number(process.env.PORT || 4076);
const HOST = process.env.HOST || '0.0.0.0';
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'filters.json');
const DIST_DIR = path.join(__dirname, 'dist');
const LOG_TTL_MS = 24 * 60 * 60 * 1000;
const logs = [];

let botProcess = null;
let startedAt = null;
let stopping = false;
let transition = Promise.resolve();

app.use(express.json({ limit: '1mb' }));

function pushLog(line) {
  const now = Date.now();
  const lines = String(line || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (const text of lines) {
    logs.push({ time: new Date(now).toISOString(), text });
  }
  while (logs.length && Date.parse(logs[0].time) < now - LOG_TTL_MS) logs.shift();
  while (logs.length > 2000) logs.shift();
}

function publicConfig(config) {
  const result = { ...config };
  result.deepseekApiKeySet = Boolean(result.deepseekApiKey);
  result.deepseekApiKey = '';
  return result;
}

function saveConfigFromRequest(body) {
  const existing = readConfig(CONFIG_FILE);
  const next = { ...(body || {}) };
  if (!next.deepseekApiKey && existing.deepseekApiKey) {
    next.deepseekApiKey = existing.deepseekApiKey;
  }
  delete next.deepseekApiKeySet;
  return writeConfig(CONFIG_FILE, next);
}

function botStatus() {
  const config = readConfig(CONFIG_FILE);
  return {
    running: Boolean(botProcess && !botProcess.killed && botProcess.exitCode === null),
    pid: botProcess?.pid || null,
    startedAt,
    logs: logs.filter((log) => Date.parse(log.time) >= Date.now() - LOG_TTL_MS).slice(-300),
    config: publicConfig(config),
    targets: buildSearchTargets(config)
  };
}

function startBot() {
  if (botStatus().running) return botStatus();
  const env = {
    ...process.env,
    CONFIG_FILE
  };
  botProcess = spawn(process.execPath, [path.join(__dirname, 'avitocian.js')], {
    cwd: __dirname,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  startedAt = new Date().toISOString();
  pushLog(`Бот запущен, PID ${botProcess.pid}`);
  botProcess.stdout.on('data', (chunk) => pushLog(chunk.toString()));
  botProcess.stderr.on('data', (chunk) => pushLog(chunk.toString()));
  const current = botProcess;
  botProcess.on('exit', (code, signal) => {
    pushLog(`Бот остановлен, code=${code ?? ''} signal=${signal ?? ''}`);
    if (botProcess === current) {
      botProcess = null;
      startedAt = null;
    }
  });
  return botStatus();
}

function killBotTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (e) {
    try {
      process.kill(pid, signal);
    } catch (_) {}
  }
}

function stopBot() {
  if (!botStatus().running) return Promise.resolve(botStatus());
  const current = botProcess;
  const pid = current.pid;
  return new Promise((resolve) => {
    const finish = () => resolve(botStatus());
    const killTimer = setTimeout(() => {
      if (current.exitCode === null) killBotTree(pid, 'SIGKILL');
    }, 1500);
    killTimer.unref();
    current.once('exit', () => {
      clearTimeout(killTimer);
      finish();
    });
    killBotTree(pid, 'SIGTERM');
  });
}

function queueTransition(task) {
  transition = transition.then(task, task);
  return transition;
}

app.get('/api/status', (req, res) => {
  res.json(botStatus());
});

app.get('/api/config', (req, res) => {
  const config = readConfig(CONFIG_FILE);
  res.json({ config: publicConfig(config), targets: buildSearchTargets(config) });
});

app.put('/api/config', async (req, res) => {
  const wasRunning = botStatus().running;
  const config = saveConfigFromRequest(req.body);
  pushLog('Фильтры сохранены');
  if (wasRunning) {
    await queueTransition(async () => {
      await stopBot();
      return startBot();
    });
  }
  res.json({ config: publicConfig(config), restarted: wasRunning, targets: buildSearchTargets(config) });
});

app.post('/api/bot/start', async (req, res) => {
  const status = await queueTransition(async () => startBot());
  res.json(status);
});

app.post('/api/bot/stop', async (req, res) => {
  const status = await queueTransition(async () => stopBot());
  res.json(status);
});

app.use(express.static(DIST_DIR));

app.use((req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

process.on('SIGINT', () => {
  stopping = true;
  stopBot();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopping = true;
  stopBot();
  setTimeout(() => process.exit(0), 500).unref();
});

app.listen(PORT, HOST, () => {
  pushLog(`Веб-интерфейс запущен на ${HOST}:${PORT}`);
  const config = readConfig(CONFIG_FILE);
  if (!stopping && config.autostart && process.env.AUTO_START_BOT !== '0') startBot();
});
