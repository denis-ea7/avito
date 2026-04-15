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
const logs = [];

let botProcess = null;
let startedAt = null;
let stopping = false;

app.use(express.json({ limit: '1mb' }));

function pushLog(line) {
  const text = String(line || '').trim();
  if (!text) return;
  logs.push({ time: new Date().toISOString(), text });
  while (logs.length > 300) logs.shift();
}

function botStatus() {
  return {
    running: Boolean(botProcess && !botProcess.killed && botProcess.exitCode === null),
    pid: botProcess?.pid || null,
    startedAt,
    logs: logs.slice(-120),
    config: readConfig(CONFIG_FILE),
    targets: buildSearchTargets(readConfig(CONFIG_FILE))
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
    stdio: ['ignore', 'pipe', 'pipe']
  });
  startedAt = new Date().toISOString();
  pushLog(`Бот запущен, PID ${botProcess.pid}`);
  botProcess.stdout.on('data', (chunk) => pushLog(chunk.toString()));
  botProcess.stderr.on('data', (chunk) => pushLog(chunk.toString()));
  botProcess.on('exit', (code, signal) => {
    pushLog(`Бот остановлен, code=${code ?? ''} signal=${signal ?? ''}`);
    botProcess = null;
    startedAt = null;
  });
  return botStatus();
}

function stopBot() {
  if (!botStatus().running) return botStatus();
  botProcess.kill('SIGTERM');
  setTimeout(() => {
    if (botStatus().running) botProcess.kill('SIGKILL');
  }, 8000).unref();
  return botStatus();
}

app.get('/api/status', (req, res) => {
  res.json(botStatus());
});

app.get('/api/config', (req, res) => {
  const config = readConfig(CONFIG_FILE);
  res.json({ config, targets: buildSearchTargets(config) });
});

app.put('/api/config', (req, res) => {
  const wasRunning = botStatus().running;
  const config = writeConfig(CONFIG_FILE, req.body || {});
  pushLog('Фильтры сохранены');
  if (wasRunning) {
    stopBot();
    setTimeout(() => startBot(), 1000).unref();
  }
  res.json({ config, restarted: wasRunning, targets: buildSearchTargets(config) });
});

app.post('/api/bot/start', (req, res) => {
  res.json(startBot());
});

app.post('/api/bot/stop', (req, res) => {
  res.json(stopBot());
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
