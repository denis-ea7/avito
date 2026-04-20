require('dotenv').config({ quiet: true });

const puppeteer = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const { anonymizeProxy } = require('proxy-chain');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readConfig, buildSearchTargets, filterDecision } = require('./lib/filters');

let playwright = null;
try {
  playwright = require('playwright');
} catch (e) {
  console.log('Playwright не установлен');
}

const SENT_FILE = path.join(__dirname, 'sent-ids.txt');
const LATEST_FILE = path.join(__dirname, 'latest-ids.json');
const GEO_CACHE_FILE = path.join(__dirname, 'geo-cache.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'filters.json');
const SKIP_TELEGRAM = process.env.SKIP_TELEGRAM === '1';
const TELEGRAM_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TG_CHAT_ID || '';
const PROXY_MODE = process.env.PROXY_MODE || 'off';
const BASE_USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const RUN_INTERVAL_MS_MIN = 50000;
const RUN_INTERVAL_MS_MAX = 100000;
const PAGE_JITTER_MIN = 12000;
const PAGE_JITTER_MAX = 25000;
const GOTO_TIMEOUT_MS = 60000;
const POST_GOTO_PAUSE_MS_MIN = 4000;
const POST_GOTO_PAUSE_MS_MAX = 9000;
const RETRIES_ON_BLOCK = 2;
const WORK_HOURS = {
  from: Number(process.env.WORK_HOUR_FROM || 8),
  to: Number(process.env.WORK_HOUR_TO || 23)
};
const AVITO_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const OKHOTNY_RYAD = { lat: 55.755804, lon: 37.614608 };

puppeteer.use(stealthPlugin());

const proxyList = (process.env.PROXY_LIST || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)
  .map((url) => ({ url }));

let proxyIndex = 0;
let runCounter = 0;
let stopping = false;
let geoCache = null;

function loadSentIds() {
  if (!fs.existsSync(SENT_FILE)) return new Set();
  return new Set(fs.readFileSync(SENT_FILE, 'utf8').split('\n').filter(Boolean));
}

function saveSentId(id) {
  fs.appendFileSync(SENT_FILE, `${id}\n`);
}

function loadLatestIds() {
  try {
    if (!fs.existsSync(LATEST_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

function saveLatestId(latestIds, key, id) {
  latestIds[key] = id;
  fs.writeFileSync(LATEST_FILE, `${JSON.stringify(latestIds, null, 2)}\n`);
}

function loadGeoCache() {
  try {
    if (!fs.existsSync(GEO_CACHE_FILE)) return { geocode: {}, stations: {} };
    const data = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
    return {
      geocode: data?.geocode && typeof data.geocode === 'object' ? data.geocode : {},
      stations: data?.stations && typeof data.stations === 'object' ? data.stations : {}
    };
  } catch (_) {
    return { geocode: {}, stations: {} };
  }
}

function getGeoCache() {
  if (!geoCache) geoCache = loadGeoCache();
  return geoCache;
}

function saveGeoCache() {
  if (geoCache) fs.writeFileSync(GEO_CACHE_FILE, `${JSON.stringify(geoCache, null, 2)}\n`);
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChromePath() {
  const platform = os.platform();
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const possiblePaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ];
  return possiblePaths.find((chromePath) => fs.existsSync(chromePath));
}

function normalizeProxyUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (/^[a-z]+:\/\//i.test(rawUrl)) return rawUrl;
  if (rawUrl.includes('@')) return `http://${rawUrl}`;
  const parts = rawUrl.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return rawUrl;
}

function getNextProxy() {
  if (!proxyList.length) return null;
  const proxy = proxyList[proxyIndex];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  return normalizeProxyUrl(proxy.url);
}

function shouldUseProxy(siteType) {
  if (PROXY_MODE === 'off') return false;
  if (siteType === 'avito') return false;
  if (siteType === 'cian') return true;
  if (siteType === 'yandex' || siteType === 'domclick') return true;
  return PROXY_MODE === 'on' || (PROXY_MODE === 'alternate' && runCounter % 2 === 1);
}

function extractListingId(source, url) {
  if (!url) return null;
  const patterns = {
    avito: /_(\d+)(?:\?|$)/,
    cian: /flat\/(\d+)/,
    yandex: /(?:offer|realty|kvartira)\/(\d+)/,
    domclick: /card\/rent__[^_]+__([0-9]+)/
  };
  const match = url.match(patterns[source]);
  if (match) return `${source}_${match[1]}`;
  return `${source}_${Buffer.from(url).toString('base64url').slice(0, 48)}`;
}

async function sendToTelegram(bot, chatId, message) {
  try {
    if (SKIP_TELEGRAM) {
      console.log(`Telegram отключен: ${message}`);
      return;
    }
    if (!bot) throw new Error('Telegram bot не инициализирован');
    if (!chatId) throw new Error('TG_CHAT_ID пустой');
    const chatIds = String(chatId).split(',').map((id) => id.trim()).filter(Boolean);
    for (const id of chatIds) {
      const sent = await bot.sendMessage(id, message, { parse_mode: 'HTML', disable_web_page_preview: false });
      console.log(`Telegram доставлено: chat ${String(sent.chat.id).slice(-4)}, message ${sent.message_id}`);
    }
  } catch (e) {
    const apiDescription = e?.response?.body?.description || e?.response?.description;
    const apiCode = e?.response?.statusCode || e?.response?.body?.error_code;
    console.error('Ошибка Telegram:', [apiCode, apiDescription, e?.message].filter(Boolean).join(' | '));
  }
}

function isWithinAllowedTimeRange() {
  const hour = new Date().getHours();
  return hour >= WORK_HOURS.from && hour < WORK_HOURS.to;
}

async function setPageFingerprint(page) {
  await page.setViewport({ width: 1200 + rand(-120, 240), height: 800 + rand(-80, 160), deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'upgrade-insecure-requests': '1',
    'accept-language': 'ru-RU,ru;q=0.9'
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

async function setAvitoMobileFingerprint(page) {
  await page.setUserAgent(AVITO_MOBILE_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await page.setExtraHTTPHeaders({
    'accept-language': 'ru-RU,ru;q=0.9'
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    const variants = ['хорошо', 'принять', 'accept', 'ok', 'закрыть'];
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const text = (button.innerText || button.getAttribute('aria-label') || '').toLowerCase();
      if (variants.some((variant) => text.includes(variant))) {
        button.click();
        return;
      }
    }
  }).catch(() => {});
}

async function safeGoto(page, url, readySelector) {
  for (let attempt = 0; attempt <= RETRIES_ON_BLOCK; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      await sleep(rand(POST_GOTO_PAUSE_MS_MIN, POST_GOTO_PAUSE_MS_MAX));
      await dismissOverlays(page);
      if (readySelector) await page.waitForSelector(readySelector, { timeout: 12000 }).catch(() => {});
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 20000) || '').catch(() => '');
      if (/доступ ограничен|вы робот|captcha|forbidden|access denied|подтвердите/i.test(text)) {
        if (attempt < RETRIES_ON_BLOCK) {
          await sleep(rand(2500, 5000));
          continue;
        }
        return false;
      }
      return true;
    } catch (e) {
      if (attempt < RETRIES_ON_BLOCK) {
        await sleep(rand(2500, 5000));
        continue;
      }
      console.error('Ошибка загрузки:', e.message);
      return false;
    }
  }
  return false;
}

async function launchPuppeteer(siteType) {
  const profileDir = process.env.PERSISTENT_CHROME_PROFILE === '1'
    ? BASE_USER_DATA_DIR
    : fs.mkdtempSync(path.join(os.tmpdir(), `avito-${siteType}-${process.pid}-`));
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--lang=ru-RU,ru',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps'
  ];
  if (shouldUseProxy(siteType)) {
    const proxy = getNextProxy();
    if (proxy) {
      try {
        const anonymized = await anonymizeProxy(proxy);
        launchArgs.push(`--proxy-server=${anonymized}`);
        console.log(`Прокси включен для ${siteType}`);
      } catch (e) {
        console.error('Прокси не применен:', e.message);
      }
    }
  }
  const launchOptions = {
    headless: 'new',
    userDataDir: profileDir,
    args: launchArgs,
    protocolTimeout: 120000
  };
  const chromePath = process.env.CHROME_PATH || getChromePath();
  if (chromePath) launchOptions.executablePath = chromePath;
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  if (siteType === 'avito') {
    await setAvitoMobileFingerprint(page);
  } else {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await setPageFingerprint(page);
  }
  return { browser, page, profileDir };
}

async function closePuppeteer(browser, profileDir) {
  await browser.close().catch(() => {});
  if (profileDir && profileDir !== BASE_USER_DATA_DIR) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function launchPlaywright(siteType) {
  if (!playwright) throw new Error('Playwright не установлен');
  const launchOptions = {
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  };
  const chromePath = process.env.CHROME_PATH || getChromePath();
  if (chromePath) launchOptions.executablePath = chromePath;
  if (shouldUseProxy(siteType)) {
    const proxy = getNextProxy();
    if (proxy) {
      const parsed = new URL(proxy);
      launchOptions.proxy = {
        server: `${parsed.protocol}//${parsed.host}`,
        username: parsed.username || undefined,
        password: parsed.password || undefined
      };
    }
  }
  const browser = await playwright.chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kmBetween(a, b) {
  const radius = 6371;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function formatKm(value) {
  if (!Number.isFinite(value)) return '';
  return value < 1 ? `${Math.round(value * 1000)} м` : `${value.toFixed(value < 10 ? 1 : 0)} км`;
}

function addressForGeo(ad) {
  const locationParts = [ad.location]
    .flatMap((value) => String(value || '').split(/\n| · |;|\|/).map(compactText))
    .filter(Boolean);
  const parts = [ad.location, ad.desc]
    .flatMap((value) => String(value || '').split(/\n| · |;|\|/).map(compactText))
    .filter(Boolean);
  const addressMarker = /(ул\.|улица|проспект|пр-кт|шоссе|переулок|пер\.|проезд|бульвар|бул\.|набережная|наб\.|площадь|пл\.|дом|д\.|корпус|к\.|мкр|микрорайон|посёлок|поселок|деревня|село)/i;
  const cityMarker = /(москва|московская|химки|подольск|балашиха|люберцы|мытищи|красногорск|долгопрудный|видное|реутов|котельники|пушкино|одинцово|домодедово|щелково|лобня|дмитров|зеленоград)/i;
  const stationMarker = /(метро|мцд|станция|ж\/д|жд|электричк)/i;
  const titleLike = /(квартира|комната|койко-место).{0,80}(аренду|снять|сдается|сдаётся|эт\.|м²|м2)/i;
  const selected = parts.filter((part) => !titleLike.test(part) && (addressMarker.test(part) || (cityMarker.test(part) && /\d/.test(part)))).slice(0, 4);
  if (!selected.length) {
    const fallback = locationParts.find((part) => !titleLike.test(part) && (addressMarker.test(part) || cityMarker.test(part) || stationMarker.test(part)));
    if (fallback) selected.push(fallback);
  }
  if (!selected.length) return '';
  const value = (selected.length ? selected.join(', ') : parts[0] || '')
    .replace(/ул\./gi, 'улица')
    .replace(/пр-кт|просп\./gi, 'проспект')
    .replace(/пер\./gi, 'переулок')
    .replace(/бул\./gi, 'бульвар')
    .replace(/наб\./gi, 'набережная')
    .replace(/пл\./gi, 'площадь')
    .replace(/\bд\./gi, 'дом')
    .replace(/от\s+\d+\s+мин\.?/gi, '')
    .replace(/(\d)([А-ЯЁ])/g, '$1, $2')
    .replace(/\s+,/g, ',')
    .slice(0, 300)
    .trim();
  if (!value) return '';
  return value;
}

function yandexRouteUrl(point, address) {
  const from = `${OKHOTNY_RYAD.lat},${OKHOTNY_RYAD.lon}`;
  const to = point ? `${point.lat},${point.lon}` : compactText(address);
  if (!to) return '';
  return `https://yandex.ru/maps/?mode=routes&rtext=${encodeURIComponent(from)}~${encodeURIComponent(to)}&rtt=mt`;
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function geocodeAd(ad) {
  const address = addressForGeo(ad);
  if (!address) return { address: '', point: null };
  const cache = getGeoCache();
  if (cache.geocode[address]) return { address, point: cache.geocode[address] };
  try {
    const queries = Array.from(new Set([
      address,
      address.replace(/,/g, ' '),
      `${address} Москва Россия`,
      `${address} Московская область Россия`,
      `${address} Россия`
    ].map(compactText).filter(Boolean)));
    for (const query of queries) {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ru&q=${encodeURIComponent(query)}`;
      const data = await fetchJson(url, { headers: { 'User-Agent': 'avito-cian-bot/1.0' } }, 10000);
      const item = Array.isArray(data) ? data[0] : null;
      const point = item ? { lat: Number(item.lat), lon: Number(item.lon), name: item.display_name || '' } : null;
      if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
        cache.geocode[address] = point;
        saveGeoCache();
        return { address, point };
      }
      await sleep(1100);
    }
  } catch (e) {
    console.error('Геокодинг не сработал:', e.message);
  }
  return { address, point: null };
}

function stationType(tags = {}) {
  const text = [tags.network, tags.operator, tags.line, tags.route, tags.ref, tags.name].filter(Boolean).join(' ');
  if (/мцд|mcd|d[1-6]|д[1-6]/i.test(text)) return 'МЦД';
  if (tags.station === 'subway' || tags.subway === 'yes' || /метро|moscow metro|московский метрополитен/i.test(text)) return 'Метро';
  if (tags.railway === 'station' || tags.railway === 'halt' || tags.train === 'yes' || tags.station === 'train') return 'ЖД';
  return '';
}

function stationName(tags = {}) {
  return compactText(tags.name || tags['name:ru'] || tags.official_name || '');
}

async function nearbyStations(point) {
  if (!point) return [];
  const cache = getGeoCache();
  const key = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  if (cache.stations[key]) return cache.stations[key];
  const body = `[out:json][timeout:25];
(
  node["railway"~"^(station|halt)$"](around:3000,${point.lat},${point.lon});
  way["railway"~"^(station|halt)$"](around:3000,${point.lat},${point.lon});
  relation["railway"~"^(station|halt)$"](around:3000,${point.lat},${point.lon});
  node["station"~"^(subway|train|light_rail)$"](around:3000,${point.lat},${point.lon});
  way["station"~"^(subway|train|light_rail)$"](around:3000,${point.lat},${point.lon});
  relation["station"~"^(subway|train|light_rail)$"](around:3000,${point.lat},${point.lon});
  node["public_transport"="station"](around:3000,${point.lat},${point.lon});
  way["public_transport"="station"](around:3000,${point.lat},${point.lon});
  relation["public_transport"="station"](around:3000,${point.lat},${point.lon});
);
out center tags;`;
  try {
    let data = null;
    let lastError = null;
    for (const endpoint of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
      try {
        data = await fetchJson(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: 'application/json',
            'User-Agent': 'avito-cian-bot/1.0'
          },
          body: new URLSearchParams({ data: body })
        }, 15000);
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!data) throw lastError || new Error('empty response');
    const seen = new Set();
    const stations = (data.elements || []).map((item) => {
      const tags = item.tags || {};
      const type = stationType(tags);
      const name = stationName(tags);
      const lat = item.lat ?? item.center?.lat;
      const lon = item.lon ?? item.center?.lon;
      if (!type || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const dedupeKey = `${type}:${name.toLowerCase()}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return { type, name, distanceKm: kmBetween(point, { lat, lon }) };
    }).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5);
    cache.stations[key] = stations;
    saveGeoCache();
    return stations;
  } catch (e) {
    console.error('Overpass не сработал:', e.message);
    return [];
  }
}

async function formatMessage(label, ad) {
  const geo = await geocodeAd(ad);
  const routeUrl = yandexRouteUrl(geo.point, geo.address);
  const stations = geo.point ? await nearbyStations(geo.point) : [];
  const lines = [escapeHtml(ad.href)];
  if (routeUrl) lines.push(`<a href="${escapeHtml(routeUrl)}">маршрут</a>`);
  if (geo.point) lines.push(`От Охотного ряда: ${escapeHtml(formatKm(kmBetween(OKHOTNY_RYAD, geo.point)))}`);
  if (stations.length) {
    lines.push('Станции:');
    lines.push(...stations.map((station) => `${escapeHtml(station.type)} ${escapeHtml(station.name)}: ${escapeHtml(formatKm(station.distanceKm))}`));
  }
  return lines.filter(Boolean).join('\n');
}

function logUrl(url) {
  return url ? ` [url:${url}]` : '';
}

function aiConfigForPrompt(filters) {
  const copy = { ...filters };
  delete copy.deepseekApiKey;
  delete copy.deepseekApiKeySet;
  return copy;
}

async function matchesAiFilter(ad, filters) {
  if (!filters.aiEnabled) return true;
  if (!filters.deepseekApiKey) {
    console.log('ИИ-фильтр включен, но ключ DeepSeek не задан');
    return true;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${filters.deepseekApiKey}`
      },
      body: JSON.stringify({
        model: filters.aiModel || 'deepseek-chat',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Ты фильтруешь объявления аренды недвижимости. Ответь только JSON вида {"match":true,"reason":"..."}. Учитывай количество комнат, общую площадь, площадь комнаты, залог, посредника, этаж, этажность, год, метро, цену. Если данных не хватает для включенного фильтра, не отклоняй объявление; отклоняй только когда известное значение явно не подходит.'
          },
          {
            role: 'user',
            content: JSON.stringify({
              filters: aiConfigForPrompt(filters),
              ad
            })
          }
        ]
      }),
      signal: controller.signal
    });
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const jsonText = content.match(/\{[\s\S]*\}/)?.[0] || content;
    const result = JSON.parse(jsonText);
    console.log(`ИИ-фильтр: ${result.match ? 'подходит' : 'отклонено'}${result.reason ? ` — ${result.reason}` : ''}`);
    return Boolean(result.match);
  } catch (e) {
    console.error('Ошибка ИИ-фильтра:', e.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, enrichAd, maxEnriched = 6) {
  const label = target.label;
  const source = target.type;
  const propertyType = target.propertyType;
  const latestKey = `${target.type}:${target.region}:${target.propertyType}`;
  const previousLatestId = latestIds[latestKey] || '';
  let enrichedCount = 0;
  for (const ad of ads) {
    if (!ad?.href) continue;
    const id = extractListingId(source, ad.href);
    if (!id) continue;
    if (previousLatestId && id === previousLatestId) break;
    if (!previousLatestId && sentIds.has(id)) {
      saveLatestId(latestIds, latestKey, id);
      console.log(`Последний новый уже был отправлен: ${label} ${id}${logUrl(ad.href)}`);
      return false;
    }
    if (sentIds.has(id)) continue;
    let normalizedAd = { ...ad, propertyType };
    let decision = filterDecision(normalizedAd, filters);
    if ((decision.detailsUseful || (decision.match && filters.aiEnabled)) && enrichAd && enrichedCount < maxEnriched) {
      enrichedCount += 1;
      normalizedAd = { ...(await enrichAd(ad)), propertyType };
      decision = filterDecision(normalizedAd, filters);
    }
    if (!decision.match) {
      console.log(`Фильтр отклонил: ${label} ${id}${logUrl(normalizedAd.href)}${decision.reason ? ` — ${decision.reason}` : ''}`);
      continue;
    }
    if (!(await matchesAiFilter(normalizedAd, filters))) continue;
    sentIds.add(id);
    saveSentId(id);
    saveLatestId(latestIds, latestKey, id);
    await sendToTelegram(bot, TELEGRAM_CHAT_ID, await formatMessage(label, normalizedAd));
    console.log(`Отправлено: ${label} ${id}${logUrl(normalizedAd.href)}`);
    return true;
  }
  console.log(`Новых подходящих нет: ${label}`);
  return false;
}

async function enrichPuppeteerAd(browser, ad, siteType) {
  if (!ad.href) return ad;
  const page = await browser.newPage();
  try {
    if (siteType === 'avito') await setAvitoMobileFingerprint(page);
    await page.goto(ad.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const pageTitle = await page.title().catch(() => '');
    const detail = await page.evaluate(() => document.body?.innerText?.slice(0, 15000) || '').catch(() => '');
    return { ...ad, title: ad.title || pageTitle, desc: [ad.desc, pageTitle, detail].filter(Boolean).join('\n') };
  } catch (_) {
    return ad;
  } finally {
    await page.close().catch(() => {});
  }
}

async function enrichPlaywrightAd(context, ad) {
  if (!ad.href) return ad;
  const page = await context.newPage();
  try {
    await page.goto(ad.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const detail = await page.evaluate(() => document.body?.innerText?.slice(0, 15000) || '').catch(() => '');
    return { ...ad, desc: [ad.desc, detail].filter(Boolean).join('\n') };
  } catch (_) {
    return ad;
  } finally {
    await page.close().catch(() => {});
  }
}

async function parseAvito(browser, page, target, filters, sentIds, latestIds, bot) {
  const ok = await safeGoto(page, target.url, 'a[href*="/kvartiry/"], a[href*="/komnaty/"]');
  if (!ok) return false;
  let ads = await page.evaluate(() => {
    const seen = new Set();
    const normalizeHref = (href) => {
      try {
        return new URL(href, location.origin).href.split('#')[0].split('?')[0];
      } catch (_) {
        return '';
      }
    };
    const titleFromHref = (href) => {
      try {
        return decodeURIComponent(new URL(href).pathname.split('/').pop() || '').replace(/_\d+$/, '').replace(/[_-]+/g, ' ').trim();
      } catch (_) {
        return '';
      }
    };
    const priceText = (value) => {
      if (value === null || value === undefined || value === '') return '';
      const number = Number(String(value).replace(/[^\d]/g, ''));
      return Number.isFinite(number) && number > 0 ? `${number.toLocaleString('ru-RU')} ₽` : String(value);
    };
    const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const addAd = (ad) => {
      const href = normalizeHref(ad.href);
      if (!href || !/_\d+$/.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);
      const title = ad.title || titleFromHref(href);
      const price = priceText(ad.price);
      const desc = [title, price, ad.desc].filter(Boolean).join('\n');
      ads.push({ href, title, price, location: ad.location || '', desc });
    };
    const ads = [];
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const data = JSON.parse(script.textContent || '{}');
        const offers = Array.isArray(data?.offers?.offers) ? data.offers.offers : Array.isArray(data?.offers) ? data.offers : [];
        for (const offer of offers) {
          addAd({ href: offer.url, title: offer.name, price: offer.price, desc: offer.description || '' });
        }
      } catch (_) {}
    }
    for (const card of Array.from(document.querySelectorAll('[class*="iva-item-content"], [data-marker^="item-wrapper"]'))) {
      const anchorSelectors = [
        'a[data-marker="item-title"][href*="/kvartiry/"], a[data-marker="item-title"][href*="/komnaty/"]',
        'a[itemprop="url"][href*="/kvartiry/"], a[itemprop="url"][href*="/komnaty/"]',
        'a[href*="/kvartiry/"], a[href*="/komnaty/"]'
      ];
      const anchor = anchorSelectors.map((selector) => card.querySelector(selector)).find(Boolean);
      const price = card.querySelector('meta[itemprop="price"]')?.getAttribute('content') || text(card.querySelector('[data-marker="item-price-value"], [data-marker="item-price"]'));
      const title = anchor?.getAttribute('title') || text(anchor) || card.querySelector('img[itemprop="image"]')?.getAttribute('alt') || '';
      const locationText = text(card.querySelector('[data-marker="item-address"], [data-marker="item-location"]'));
      const paramsText = text(card.querySelector('[data-marker="item-specific-params"]'));
      const dateText = text(card.querySelector('[data-marker="item-date"], [data-marker="item-date/wrapper"]'));
      const bodyText = text(card.querySelector('.iva-item-bottomBlock-VewGa, [class*="iva-item-bottomBlock"]'));
      addAd({
        href: anchor?.href || anchor?.getAttribute('href') || '',
        title,
        price,
        location: locationText,
        desc: [paramsText, locationText, dateText, bodyText].filter(Boolean).join('\n')
      });
    }
    for (const anchor of Array.from(document.querySelectorAll('a[href*="/kvartiry/"], a[href*="/komnaty/"]'))) {
      const wrapper = anchor.closest('[data-marker^="item-wrapper"], article, li, div');
      addAd({
        href: anchor.href || anchor.getAttribute('href') || '',
        title: anchor.getAttribute('title') || anchor.querySelector('[data-marker="item/link-text"]')?.textContent?.trim() || '',
        price: '',
        desc: wrapper?.innerText || anchor.innerText || ''
      });
    }
    return ads.slice(0, 15);
  }).catch(() => []);
  console.log(`Авито найдено карточек: ${ads.length}`);
  return emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, (ad) => enrichPuppeteerAd(browser, ad, 'avito'), 15);
}

async function parseCian(browser, page, target, filters, sentIds, latestIds, bot) {
  const ok = await safeGoto(page, target.url, 'article[data-name="CardComponent"]');
  if (!ok) return false;
  let ads = await page.$$eval('article[data-name="CardComponent"]', (nodes) => nodes.slice(0, 15).map((card) => {
    const href = card.querySelector('a[href*="/rent/flat/"]')?.href?.split('?')[0] || '';
    const title = card.querySelector('[data-mark="OfferTitle"]')?.textContent?.trim() || '';
    const price = card.querySelector('[data-mark="MainPrice"]')?.textContent?.trim() || '';
    const location = card.querySelector('div[data-name="SpecialGeo"]')?.textContent?.trim() || '';
    const desc = card.querySelector('[data-name="Description"]')?.textContent?.trim() || card.innerText || '';
    return { href, title, price, location, desc };
  })).catch(() => []);
  return emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, (ad) => enrichPuppeteerAd(browser, ad, 'cian'));
}

async function parseYandex(context, page, target, filters, sentIds, latestIds, bot) {
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  let ads = await page.evaluate(() => {
    const selectors = [
      'li.OffersSerpItem',
      'li[class*="OffersSerpItem"]',
      '[data-test="OffersSerpItem"]'
    ];
    const cards = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).slice(0, 15);
    return cards.map((card) => {
      const anchor = card.querySelector('a.OffersSerpItem__link, a[href*="/offer/"], a[href*="/realty/"]');
      const text = card.innerText || '';
      const href = anchor?.href?.split('?')[0] || '';
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      return {
        href,
        title: lines[0] || '',
        price: lines.find((line) => /₽|руб/i.test(line)) || '',
        location: lines.find((line) => /метро|москва|область|ул\.|улица/i.test(line)) || '',
        desc: text
      };
    });
  }).catch(() => []);
  return emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, (ad) => enrichPlaywrightAd(context, ad));
}

async function parseDomclick(context, page, target, filters, sentIds, latestIds, bot) {
  await page.goto('https://domclick.ru/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://domclick.ru/' });
  await page.waitForTimeout(2500);
  let ads = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/card/"]')).slice(0, 15);
    return anchors.map((anchor) => {
      const card = anchor.closest('article, li, div') || anchor;
      const text = card.innerText || anchor.innerText || '';
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      return {
        href: anchor.href.split('?')[0],
        title: anchor.getAttribute('aria-label') || lines[0] || '',
        price: lines.find((line) => /₽|руб/i.test(line)) || '',
        location: lines.find((line) => /метро|москва|область|ул\.|улица/i.test(line)) || '',
        desc: text
      };
    });
  }).catch(() => []);
  return emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, (ad) => enrichPlaywrightAd(context, ad));
}

async function processTarget(target, filters, sentIds, latestIds, bot) {
  console.log(`Обработка: ${target.label}`);
  if (target.type === 'avito' || target.type === 'cian') {
    const { browser, page, profileDir } = await launchPuppeteer(target.type);
    try {
      if (target.type === 'avito') return await parseAvito(browser, page, target, filters, sentIds, latestIds, bot);
      return await parseCian(browser, page, target, filters, sentIds, latestIds, bot);
    } finally {
      await closePuppeteer(browser, profileDir);
    }
  }
  const { browser, context, page } = await launchPlaywright(target.type);
  try {
    if (target.type === 'yandex') return await parseYandex(context, page, target, filters, sentIds, latestIds, bot);
    return await parseDomclick(context, page, target, filters, sentIds, latestIds, bot);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function oneRun(sentIds, latestIds, bot) {
  if (!isWithinAllowedTimeRange()) {
    console.log(`Вне рабочего времени ${WORK_HOURS.from}:00-${WORK_HOURS.to}:00`);
    return;
  }
  const filters = readConfig(CONFIG_FILE);
  const targets = buildSearchTargets(filters);
  runCounter += 1;
  console.log(`Запуск #${runCounter}. Источников: ${targets.length}`);
  for (const target of targets) {
    if (stopping) return;
    try {
      await processTarget(target, filters, sentIds, latestIds, bot);
    } catch (e) {
      console.error(`Ошибка ${target.label}:`, e.message);
    }
    if (!stopping) await sleep(rand(PAGE_JITTER_MIN, PAGE_JITTER_MAX));
  }
}

async function main() {
  let bot = null;
  if (!SKIP_TELEGRAM) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error('Не задан TG_BOT_TOKEN');
    if (!TELEGRAM_CHAT_ID) throw new Error('Не задан TG_CHAT_ID');
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('Telegram включен');
  }
  const sentIds = loadSentIds();
  const latestIds = loadLatestIds();
  if (process.env.SINGLE_RUN === '1') {
    await oneRun(sentIds, latestIds, bot);
    return;
  }
  while (!stopping) {
    await oneRun(sentIds, latestIds, bot);
    const wait = rand(RUN_INTERVAL_MS_MIN, RUN_INTERVAL_MS_MAX);
    console.log(`Следующий прогон через ${Math.round(wait / 1000)} секунд`);
    await sleep(wait);
  }
}

process.on('SIGINT', () => {
  stopping = true;
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopping = true;
  setTimeout(() => process.exit(0), 300);
});

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
