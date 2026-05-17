require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { readConfig, writeConfig, buildSearchTargets } = require('./lib/filters');
const { readSentListings, saveSentListing } = require('./lib/sent-listings');

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
    const urlMatch = text.match(/\s*\[url:(https?:\/\/[^\]]+)\]/);
    logs.push({
      time: new Date(now).toISOString(),
      text: text.replace(/\s*\[url:https?:\/\/[^\]]+\]/, ''),
      url: urlMatch?.[1] || ''
    });
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

function toFilterNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function detectSourceFromHref(href) {
  const url = String(href || '');
  if (/avito/i.test(url)) return 'avito';
  if (/cian/i.test(url)) return 'cian';
  if (/yandex/i.test(url)) return 'yandex';
  if (/domclick/i.test(url)) return 'domclick';
  return '';
}

async function resolveListingRoute(href, source, title = '', priceText = '') {
  const mod = require('./avitocian');
  const siteType = source || detectSourceFromHref(href);
  if (!href || !siteType) return '';
  const ad = { href, title, price: priceText, location: '', desc: '' };
  if (siteType === 'avito' || siteType === 'cian') {
    const { browser, profileDir } = await mod.launchPuppeteer(siteType);
    try {
      const detailed = await mod.enrichPuppeteerAd(browser, ad, siteType);
      const geo = await mod.resolvePreferredGeo(detailed);
      return mod.yandexRouteUrl(geo.address, geo.point);
    } finally {
      await mod.closePuppeteer(browser, profileDir);
    }
  }
  const { browser, context } = await mod.launchPlaywright(siteType);
  try {
    const detailed = await mod.enrichPlaywrightAd(context, ad, siteType);
    const geo = await mod.resolvePreferredGeo(detailed);
    return mod.yandexRouteUrl(geo.address, geo.point);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
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

app.get('/api/sent-listings', (req, res) => {
  const priceMin = toFilterNumber(req.query.priceMin);
  const priceMax = toFilterNumber(req.query.priceMax);
  const limit = Math.max(1, Math.min(1000, toFilterNumber(req.query.limit) || 300));
  const items = readSentListings()
    .filter((item) => priceMin === null || (item.priceValue !== null && item.priceValue >= priceMin))
    .filter((item) => priceMax === null || (item.priceValue !== null && item.priceValue <= priceMax))
    .sort((left, right) => Date.parse(right.sentAt || 0) - Date.parse(left.sentAt || 0));
  res.json({
    total: items.length,
    items: items.slice(0, limit)
  });
});

app.get('/api/sent-listings/route', async (req, res) => {
  try {
    const href = String(req.query.href || '').trim();
    const source = String(req.query.source || '').trim();
    if (!href) return res.status(400).send('href is required');
    const items = readSentListings();
    const existing = items.find((item) => item.href === href);
    if (existing?.routeUrl) return res.redirect(existing.routeUrl);
    const routeUrl = await resolveListingRoute(href, source || existing?.source, existing?.title, existing?.priceText);
    if (!routeUrl) return res.status(404).send('route not found');
    if (existing) saveSentListing({ ...existing, routeUrl });
    return res.redirect(routeUrl);
  } catch (error) {
    return res.status(500).send(error.message || 'route error');
  }
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
