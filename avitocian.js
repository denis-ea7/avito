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
const OKHOTNY_RYAD = { lat: 55.756762, lon: 37.616434 };

puppeteer.use(stealthPlugin());

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

function currentProxyConfig() {
  const config = readConfig(CONFIG_FILE);
  return {
    mode: config.proxyMode || process.env.PROXY_MODE || 'off',
    list: String(config.proxyList || process.env.PROXY_LIST || '')
      .split(/\r?\n|,/)
      .map((url) => url.trim())
      .filter(Boolean)
      .map((url) => ({ url }))
  };
}

function getNextProxy() {
  const proxyList = currentProxyConfig().list;
  if (!proxyList.length) return null;
  const proxy = proxyList[proxyIndex];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  return normalizeProxyUrl(proxy.url);
}

function shouldUseProxy(siteType) {
  const { mode, list } = currentProxyConfig();
  if (mode === 'off' || !list.length) return false;
  if (siteType === 'cian') return true;
  if (siteType === 'yandex' || siteType === 'domclick') return true;
  if (siteType === 'avito') return mode === 'on' || (mode === 'alternate' && runCounter % 2 === 1);
  return mode === 'on' || (mode === 'alternate' && runCounter % 2 === 1);
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

async function sendToTelegram(bot, chatId, payload) {
  try {
    if (SKIP_TELEGRAM) {
      console.log(`Telegram отключен: ${typeof payload === 'string' ? payload : payload?.text || ''}`);
      return;
    }
    if (!bot) throw new Error('Telegram bot не инициализирован');
    if (!chatId) throw new Error('TG_CHAT_ID пустой');
    const text = typeof payload === 'string' ? payload : payload?.text || '';
    const replyMarkup = typeof payload === 'string' ? undefined : payload?.reply_markup;
    const chatIds = String(chatId).split(',').map((id) => id.trim()).filter(Boolean);
    for (const id of chatIds) {
      const sent = await bot.sendMessage(id, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: replyMarkup
      });
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

const ADDRESS_MARKER = /(ул\.|улица|проспект|пр-кт|шоссе|ш\.|переулок|пер\.|проезд|пр-д|бульвар|бул\.|набережная|наб\.|площадь|пл\.|дом|д\.|корпус|к\.|строен(?:ие)?|стр\.|мкр|мкр-н|микрорайон|посёлок|поселок|деревня|село|аллея|ал\.|тупик|квартал)/i;
const CITY_MARKER = /(москва|московская область|московская обл|химки|подольск|балашиха|люберцы|мытищи|красногорск|долгопрудный|видное|реутов|котельники|пушкино|одинцово|домодедово|щелково|щёлково|лобня|дмитров|зеленоград|зеленоградский|корол[её]в|ивантеевка|раменское|жуковский|пушкин[оа]|сходня|нахабино|апрелевка|железнодорожный)/i;
const STATION_MARKER = /(метро|мцд|станция|ж\/д|жд|электричк|платформа)/i;
const TITLE_LIKE = /(квартира|комната|койко-место).{0,80}(аренду|снять|сдается|сдаётся|эт\.|м²|м2)/i;
const SEARCH_LIKE = /(снять|сдам|сдается|сдаётся|объявление|база циан|на авито|снять квартиру|снять комнату)/i;

function normalizeAddressCandidate(value) {
  return compactText(value)
    .replace(/На карте.*$/i, '')
    .replace(/ул\./gi, 'улица')
    .replace(/пр-кт|просп\./gi, 'проспект')
    .replace(/пр-д/gi, 'проезд')
    .replace(/ш\./gi, 'шоссе')
    .replace(/пер\./gi, 'переулок')
    .replace(/бул\./gi, 'бульвар')
    .replace(/наб\./gi, 'набережная')
    .replace(/пл\./gi, 'площадь')
    .replace(/ал\./gi, 'аллея')
    .replace(/мкр-н/gi, 'микрорайон')
    .replace(/стр\./gi, 'строение')
    .replace(/\bд\./gi, 'дом')
    .replace(/\bк\./gi, 'корпус')
    .replace(/от\s+\d+\s+мин\.?/gi, '')
    .replace(/\b(метро|мцд|станция)\b.*$/i, '')
    .replace(/\b(пешком|на транспорте|транспортом)\b.*$/i, '')
    .replace(/(\d)([А-ЯЁ])/g, '$1, $2')
    .replace(/\s+,/g, ',')
    .replace(/,+/g, ',')
    .slice(0, 300)
    .trim();
}

function pointFromMapUrl(url) {
  try {
    const parsed = new URL(url, 'https://maps.yandex.ru');
    const pt = parsed.searchParams.get('pt');
    if (pt) {
      const [lon, lat] = pt.split(',').map((value) => Number(value));
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
    const ll = parsed.searchParams.get('ll');
    if (ll) {
      const [lon, lat] = ll.split(',').map((value) => Number(value));
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  } catch (_) {}
  return null;
}

function decodeScriptString(value) {
  return String(value || '')
    .replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractAddressFromRaw(raw) {
  const text = String(raw || '');
  const patterns = [
    /"(?:fullAddress|formattedAddress|addressLine|displayAddress|geoAddress)"\s*:\s*"([^"]{12,220})"/i,
    /"address"\s*:\s*"([^"]{12,220})"/i,
    /"address"\s*:\s*\{[\s\S]{0,600}?"formatted"\s*:\s*"([^"]{12,220})"/i,
    /"address"\s*:\s*\{[\s\S]{0,600}?"fullAddress"\s*:\s*"([^"]{12,220})"/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const address = normalizeAddressCandidate(decodeScriptString(match[1]));
    if (addressScore(address) >= 20) return address;
  }
  return '';
}

function regionHint(text) {
  const normalized = compactText(text).toLowerCase();
  if (!normalized) return '';
  if (/москва\b/.test(normalized)) return 'Москва';
  if (/московская область|московская обл/.test(normalized)) return 'Московская область';
  if (/(химки|подольск|балашиха|люберцы|мытищи|красногорск|долгопрудный|видное|реутов|котельники|пушкино|одинцово|домодедово|щелково|щёлково|лобня|дмитров|зеленоград|корол[её]в|ивантеевка|раменское|жуковский|сходня|нахабино|апрелевка|железнодорожный)\b/.test(normalized)) return 'Московская область';
  return '';
}

function addressScore(value) {
  if (!value || TITLE_LIKE.test(value) || SEARCH_LIKE.test(value)) return -100;
  let score = 0;
  if (ADDRESS_MARKER.test(value)) score += 40;
  if (CITY_MARKER.test(value)) score += 25;
  if (/\b\d{1,4}[а-яё]?(?:\/\d+)?\b/i.test(value)) score += 18;
  if (/,/.test(value)) score += 5;
  if (STATION_MARKER.test(value)) score -= 35;
  if (/\b(мин|пешком|транспорт|район|округ|жк)\b/i.test(value)) score -= 15;
  if (value.length < 12) score -= 20;
  return score;
}

function isPreciseAddress(value) {
  const text = compactText(value);
  if (!text || addressScore(text) < 20) return false;
  if (!ADDRESS_MARKER.test(text)) return false;
  return /\b\d{1,4}[а-яё]?(?:\/\d+)?\b/i.test(text) || /(улица|проспект|шоссе|переулок|проезд|бульвар|набережная|площадь|дом|корпус|строение|микрорайон|квартал)/i.test(text);
}

function hrefAddressFallback(href) {
  try {
    const parsed = new URL(href);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const cityPart = parts[0] || '';
    const normalized = cityPart
      .replace(/^moskovskaya_oblast_/i, '')
      .replace(/^moskva_i_mo$/i, 'moskva moskovskaya oblast')
      .replace(/^moskva$/i, 'moskva')
      .replace(/_/g, ' ')
      .trim();
    const dictionary = [
      ['moskva', 'Москва'],
      ['moskovskaya oblast', 'Московская область'],
      ['krasnogorsk', 'Красногорск'],
      ['lytkarino', 'Лыткарино'],
      ['orehovo zuevo', 'Орехово-Зуево'],
      ['orekhovo zuevo', 'Орехово-Зуево'],
      ['domodedovo', 'Домодедово'],
      ['podolsk', 'Подольск'],
      ['khimki', 'Химки'],
      ['lyubertsy', 'Люберцы'],
      ['vidnoe', 'Видное'],
      ['odintsovo', 'Одинцово'],
      ['reutov', 'Реутов'],
      ['dolgoprudnyy', 'Долгопрудный'],
      ['mytishchi', 'Мытищи']
    ];
    let value = normalized;
    for (const [from, to] of dictionary) {
      value = value.replace(new RegExp(`\\b${from}\\b`, 'gi'), to);
    }
    value = compactText(value);
    return value && CITY_MARKER.test(value) ? value : '';
  } catch (_) {
    return '';
  }
}

function addressCandidates(ad) {
  const raw = [ad.address, ad.location, ad.desc].filter(Boolean).join('\n');
  const hint = regionHint(raw);
  const parts = raw
    .split(/\n| · |;|\|/)
    .map(compactText)
    .filter(Boolean);
  const labeled = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const inline = part.match(/^(?:адрес|расположение|местоположение)\s*[:\-]?\s*(.+)$/i);
    if (inline?.[1]) labeled.push(inline[1]);
    if (/^(?:адрес|расположение|местоположение)\s*[:\-]?$/i.test(part) && parts[index + 1]) labeled.push(parts[index + 1]);
  }
  const candidates = [...labeled, ...parts]
    .map(normalizeAddressCandidate)
    .filter(Boolean)
    .filter((value) => !TITLE_LIKE.test(value) && !SEARCH_LIKE.test(value))
    .map((value) => (hint && !CITY_MARKER.test(value) ? `${value}, ${hint}` : value))
    .map((value) => value.replace(/,\s*(Москва|Московская область),\s*\1/i, ', $1'))
    .map((value) => value.replace(/,\s*Россия$/i, ''))
    .filter((value) => addressScore(value) >= 20);
  const fallback = hrefAddressFallback(ad.href || '');
  return Array.from(new Set([...candidates, fallback].filter(Boolean))).sort((left, right) => addressScore(right) - addressScore(left));
}

function addressForGeo(ad) {
  return addressCandidates(ad)[0] || '';
}

function addressFromTextBlock(text) {
  const raw = String(text || '');
  const hint = regionHint(raw);
  const lines = raw.split(/\n|\||;/).map(compactText).filter(Boolean);
  const mapIndex = lines.findIndex((line) => /^(показать )?на карте$/i.test(line));
  const aroundMap = mapIndex > 0 ? [lines[mapIndex - 1], lines[mapIndex - 2]].filter(Boolean) : [];
  const directMatches = [];
  for (const line of lines) {
    const match = line.match(/((?:Москва|Московская\s+обл\.?|Московская\s+область)[^,\n]{0,80}(?:,\s*[^,\n]{1,80}){1,6})/i);
    if (match?.[1]) directMatches.push(match[1]);
  }
  const candidates = [...aroundMap, ...directMatches, ...lines]
    .map(normalizeAddressCandidate)
    .filter(Boolean)
    .filter((value) => !TITLE_LIKE.test(value) && !SEARCH_LIKE.test(value))
    .map((value) => (hint && !CITY_MARKER.test(value) ? `${value}, ${hint}` : value))
    .map((value) => value.replace(/,\s*(Москва|Московская область),\s*\1/i, ', $1'))
    .map((value) => value.replace(/,\s*Россия$/i, ''))
    .filter(isPreciseAddress);
  return Array.from(new Set(candidates)).sort((left, right) => addressScore(right) - addressScore(left))[0] || '';
}

function routeDebugLine(label, geo) {
  const address = compactText(geo?.address || '') || 'нет';
  const point = geo?.point && Number.isFinite(geo.point.lat) && Number.isFinite(geo.point.lon)
    ? `${geo.point.lat.toFixed(6)},${geo.point.lon.toFixed(6)}`
    : 'нет';
  const source = geo?.source || 'none';
  return `Маршрут ${label}: адрес="${address}" координаты=${point} источник=${source}`;
}

function twoGisRouteUrl(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return '';
  const from = `${OKHOTNY_RYAD.lon},${OKHOTNY_RYAD.lat}`;
  const to = `${point.lon},${point.lat}`;
  const centerLon = ((OKHOTNY_RYAD.lon + point.lon) / 2).toFixed(6);
  const centerLat = ((OKHOTNY_RYAD.lat + point.lat) / 2).toFixed(6);
  return `https://2gis.ru/moscow/directions/points/${from}|${to}?m=${centerLon},${centerLat}/12.31`;
}

function twoGisSearchUrl(address) {
  const query = compactText(address);
  if (!query) return '';
  return `https://2gis.ru/search/${encodeURIComponent(query)}`;
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

async function geocodeWithNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ru&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url, { headers: { 'User-Agent': 'avito-cian-bot/1.0' } }, 10000);
  const item = Array.isArray(data) ? data[0] : null;
  if (!item) return null;
  const point = { lat: Number(item.lat), lon: Number(item.lon), name: item.display_name || '' };
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) ? point : null;
}

async function geocodeWithPhoton(query) {
  const url = `https://photon.komoot.io/api/?limit=1&lang=ru&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url, { headers: { 'User-Agent': 'avito-cian-bot/1.0' } }, 10000);
  const feature = Array.isArray(data?.features) ? data.features[0] : null;
  const coordinates = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const point = {
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    name: compactText(feature?.properties?.name || feature?.properties?.street || '')
  };
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) ? point : null;
}

async function geocodeAd(ad) {
  if (Number.isFinite(ad?.coords?.lat) && Number.isFinite(ad?.coords?.lon)) {
    return {
      address: compactText(ad.address || addressForGeo(ad)),
      point: {
        lat: Number(ad.coords.lat),
        lon: Number(ad.coords.lon),
        name: compactText(ad.address || '')
      },
      source: 'listing-coords'
    };
  }
  const candidates = addressCandidates(ad);
  const preciseCandidates = candidates.filter(isPreciseAddress);
  const address = preciseCandidates[0] || candidates[0] || '';
  if (!address) return { address: '', point: null, source: 'none' };
  if (!preciseCandidates.length) return { address, point: null, source: 'search-only' };
  const cache = getGeoCache();
  for (const candidate of preciseCandidates) {
    if (cache.geocode[candidate]) return { address: candidate, point: cache.geocode[candidate], source: 'cache' };
  }
  try {
    for (const candidate of preciseCandidates) {
      const queries = Array.from(new Set([
        candidate,
        candidate.replace(/,/g, ' '),
        `${candidate} Россия`
      ].map(compactText).filter(Boolean)));
      for (const query of queries) {
        const providers = [
          ['geocoder-nominatim', geocodeWithNominatim],
          ['geocoder-photon', geocodeWithPhoton]
        ];
        for (const [source, provider] of providers) {
          const point = await provider(query).catch(() => null);
          if (!point) continue;
          cache.geocode[candidate] = point;
          saveGeoCache();
          return { address: candidate, point, source };
        }
        await sleep(1100);
      }
    }
  } catch (e) {
    console.error('Геокодинг не сработал:', e.message);
  }
  return { address, point: null, source: 'no-point' };
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
  console.log(routeDebugLine(label, geo));
  const lines = [escapeHtml(ad.href)];
  const keyboard = [];
  if (geo.address) lines.push(`Адрес: ${escapeHtml(geo.address)}`);
  if (geo.address) {
    keyboard.push([{
      text: 'Копировать адрес',
      copy_text: { text: geo.address.slice(0, 256) }
    }]);
  }
  if (geo.point) {
    const coords = `${geo.point.lat.toFixed(6)}, ${geo.point.lon.toFixed(6)}`;
    lines.push(`Координаты: <code>${escapeHtml(coords)}</code>`);
    keyboard.push([{
      text: 'Копировать координаты',
      copy_text: { text: coords }
    }]);
  }
  return {
    text: lines.filter(Boolean).join('\n'),
    reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined
  };
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
    let wasEnriched = false;
    let decision = filterDecision(normalizedAd, filters);
    if ((decision.detailsUseful || (decision.match && filters.aiEnabled)) && enrichAd && enrichedCount < maxEnriched) {
      enrichedCount += 1;
      normalizedAd = { ...(await enrichAd(ad)), propertyType };
      wasEnriched = true;
      decision = filterDecision(normalizedAd, filters);
    }
    if (!decision.match) {
      console.log(`Фильтр отклонил: ${label} ${id}${logUrl(normalizedAd.href)}${decision.reason ? ` — ${decision.reason}` : ''}`);
      continue;
    }
    if (enrichAd && !wasEnriched && enrichedCount < maxEnriched) {
      enrichedCount += 1;
      normalizedAd = { ...(await enrichAd(normalizedAd)), propertyType };
      decision = filterDecision(normalizedAd, filters);
      if (!decision.match) {
        console.log(`Фильтр отклонил после детализации: ${label} ${id}${logUrl(normalizedAd.href)}${decision.reason ? ` — ${decision.reason}` : ''}`);
        continue;
      }
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
    const rawHtml = await page.content().catch(() => '');
    const extra = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.slice(0, 15000) || '';
      const normalizeAddress = (value) => String(value || '').replace(/\s+/g, ' ').replace(/На карте.*$/i, '').trim();
      const lines = bodyText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const mapIndex = lines.findIndex((line) => /^(показать )?на карте$/i.test(line));
      const mapAddress = mapIndex > 0 ? normalizeAddress(lines[mapIndex - 1]) : '';
      const readStructured = () => {
        const readFromText = (text) => {
          const itemMatch = text.match(/"item":\{[\s\S]*?"address":"([^"]+)"[\s\S]*?"coords":\{"lat":([0-9.]+),"lng":([0-9.]+)\}/);
          if (itemMatch) {
            return {
              address: itemMatch[1],
              coords: { lat: Number(itemMatch[2]), lon: Number(itemMatch[3]) }
            };
          }
          const addressMatch = text.match(/"address":"([^"]+)"/);
          const itemCoordsMatch = text.match(/"item":\{[\s\S]*?"coords":\{"lat":([0-9.]+),"lng":([0-9.]+)\}/);
          if (addressMatch || itemCoordsMatch) {
            return {
              address: addressMatch?.[1] || '',
              coords: itemCoordsMatch ? { lat: Number(itemCoordsMatch[1]), lon: Number(itemCoordsMatch[2]) } : null
            };
          }
          return null;
        };
        for (const script of Array.from(document.querySelectorAll('script'))) {
          const raw = script.textContent || '';
          if (!raw) continue;
          const variants = [raw];
          if (raw.includes('%7B')) {
            try {
              variants.push(decodeURIComponent(raw));
            } catch (_) {}
          }
          for (const text of variants) {
            const result = readFromText(text);
            if (result) return result;
          }
        }
        return { address: '', coords: null };
      };
      const structured = readStructured();
      const geoAddress = siteType === 'cian'
        ? normalizeAddress(document.querySelector('[data-name="Geo"]')?.innerText || '')
        : '';
      return {
        detail: bodyText,
        address: structured.address || geoAddress || mapAddress,
        coords: structured.coords
      };
    }).catch(() => ({ detail: '', address: '', coords: null }));
    const rawAddress = extractAddressFromRaw(rawHtml);
    const detailAddress = addressFromTextBlock(extra.detail);
    return {
      ...ad,
      title: ad.title || pageTitle,
      address: compactText(extra.address || rawAddress || detailAddress || ad.address || ''),
      coords: extra.coords && Number.isFinite(extra.coords.lat) && Number.isFinite(extra.coords.lon) ? extra.coords : ad.coords || null,
      desc: [ad.desc, pageTitle, extra.detail].filter(Boolean).join('\n')
    };
  } catch (_) {
    return ad;
  } finally {
    await page.close().catch(() => {});
  }
}

async function enrichPlaywrightAd(context, ad, siteType) {
  if (!ad.href) return ad;
  const page = await context.newPage();
  try {
    await page.goto(ad.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const rawHtml = await page.content().catch(() => '');
    const extra = await page.evaluate((currentSiteType) => {
      const bodyText = document.body?.innerText?.slice(0, 15000) || '';
      const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const lines = bodyText.split('\n').map(compact).filter(Boolean);
      const mapIndex = lines.findIndex((line) => /^(показать )?на карте$/i.test(line));
      const mapLink = Array.from(document.querySelectorAll('a'))
        .map((link) => ({ text: compact(link.innerText), href: link.href || link.getAttribute('href') || '' }))
        .find((link) => /Яндекс/.test(link.text) && /maps\.yandex|maps\.yandex\.ru|yandex\.ru\/maps/.test(link.href));
      const lineAddress = lines.find((line) => /(ул\.|улица|проспект|проезд|шоссе|ш\.|переулок|бульвар|набережная|площадь|аллея|тупик|квартал)/i.test(line) && /(москва|московская|химки|люберцы|подольск|мытищи|красногорск|долгопрудный|реутов|одинцово|домодедово|лобня|зеленоград)/i.test(line));
      const mapAddress = mapIndex > 0 ? compact(lines[mapIndex - 1]).replace(/На карте.*$/i, '') : '';
      const exactAddress = currentSiteType === 'yandex'
        ? lines.find((line) => /(москва|московская)/i.test(line) && /(ул\.|улица|проспект|проезд|шоссе|ш\.|переулок|бульвар|набережная|площадь)/i.test(line))
        : lineAddress || mapAddress;
      return {
        detail: bodyText,
        address: exactAddress || mapAddress || lineAddress || '',
        mapHref: mapLink?.href || ''
      };
    }, siteType).catch(() => ({ detail: '', address: '', mapHref: '' }));
    const coords = pointFromMapUrl(extra.mapHref);
    const rawAddress = extractAddressFromRaw(rawHtml);
    const detailAddress = addressFromTextBlock(extra.detail);
    return {
      ...ad,
      address: compactText(extra.address || rawAddress || detailAddress || ad.address || ''),
      coords: coords || ad.coords || null,
      desc: [ad.desc, extra.detail].filter(Boolean).join('\n')
    };
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
  return emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, (ad) => enrichPlaywrightAd(context, ad, 'yandex'));
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
  return emitFirstMatching(target, ads, filters, sentIds, latestIds, bot, (ad) => enrichPlaywrightAd(context, ad, 'domclick'));
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
