require('dotenv').config({ quiet: true });

const puppeteer = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const { anonymizeProxy } = require('proxy-chain');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readConfig, buildSearchTargets, matchesFilters } = require('./lib/filters');

let playwright = null;
try {
  playwright = require('playwright');
} catch (e) {
  console.log('Playwright не установлен');
}

const SENT_FILE = path.join(__dirname, 'sent-ids.txt');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'filters.json');
const SKIP_TELEGRAM = process.env.SKIP_TELEGRAM === '1';
const TELEGRAM_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TG_CHAT_ID || '';
const PROXY_MODE = process.env.PROXY_MODE || 'off';
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
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

puppeteer.use(stealthPlugin());

const proxyList = (process.env.PROXY_LIST || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)
  .map((url) => ({ url }));

let proxyIndex = 0;
let runCounter = 0;
let stopping = false;

function loadSentIds() {
  if (!fs.existsSync(SENT_FILE)) return new Set();
  return new Set(fs.readFileSync(SENT_FILE, 'utf8').split('\n').filter(Boolean));
}

function saveSentId(id) {
  fs.appendFileSync(SENT_FILE, `${id}\n`);
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
      await bot.sendMessage(id, message, { parse_mode: 'HTML', disable_web_page_preview: false });
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
    userDataDir: USER_DATA_DIR,
    args: launchArgs,
    protocolTimeout: 120000
  };
  const chromePath = process.env.CHROME_PATH || getChromePath();
  if (chromePath) launchOptions.executablePath = chromePath;
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await setPageFingerprint(page);
  return { browser, page };
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

function formatMessage(label, ad) {
  return [
    `🏠 <b>${ad.title || label}</b>`,
    ad.price ? `💰 ${ad.price}` : '',
    ad.location ? `📍 ${ad.location}` : '',
    ad.desc ? `\n${ad.desc}` : '',
    `🔗 ${ad.href}`
  ].filter(Boolean).join('\n');
}

async function emitFirstMatching(label, source, ads, filters, sentIds, bot) {
  for (const ad of ads) {
    if (!ad?.href) continue;
    const id = extractListingId(source, ad.href);
    if (!id || sentIds.has(id)) continue;
    if (!matchesFilters(ad, filters)) continue;
    sentIds.add(id);
    saveSentId(id);
    await sendToTelegram(bot, TELEGRAM_CHAT_ID, formatMessage(label, ad));
    console.log(`Отправлено: ${label} ${id}`);
    return true;
  }
  return false;
}

async function parseAvito(page, target, filters, sentIds, bot) {
  const ok = await safeGoto(page, target.url, '[data-marker="item"], a[itemprop="url"]');
  if (!ok) return false;
  const ads = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-marker="item"]')).slice(0, 15);
    const source = cards.length ? cards : Array.from(document.querySelectorAll('a[itemprop="url"]')).slice(0, 15);
    return source.map((node) => {
      const anchor = node.matches?.('a') ? node : node.querySelector('a[itemprop="url"], a[href*="/moskva/"]');
      const text = node.innerText || anchor?.innerText || '';
      const href = anchor?.href?.replace('m.avito.ru', 'www.avito.ru') || '';
      const title = node.querySelector?.('[itemprop="name"], h3')?.textContent?.trim() || text.split('\n')[0] || '';
      const price = node.querySelector?.('[itemprop="price"], [data-marker="item-price"]')?.textContent?.trim() || '';
      return { href, title, price, location: text, desc: text };
    });
  }).catch(() => []);
  return emitFirstMatching(target.label, 'avito', ads, filters, sentIds, bot);
}

async function parseCian(page, target, filters, sentIds, bot) {
  const ok = await safeGoto(page, target.url, 'article[data-name="CardComponent"]');
  if (!ok) return false;
  const ads = await page.$$eval('article[data-name="CardComponent"]', (nodes) => nodes.slice(0, 15).map((card) => {
    const href = card.querySelector('a[href*="/rent/flat/"]')?.href?.split('?')[0] || '';
    const title = card.querySelector('[data-mark="OfferTitle"]')?.textContent?.trim() || '';
    const price = card.querySelector('[data-mark="MainPrice"]')?.textContent?.trim() || '';
    const location = card.querySelector('div[data-name="SpecialGeo"]')?.textContent?.trim() || '';
    const desc = card.querySelector('[data-name="Description"]')?.textContent?.trim() || card.innerText || '';
    return { href, title, price, location, desc };
  })).catch(() => []);
  return emitFirstMatching(target.label, 'cian', ads, filters, sentIds, bot);
}

async function parseYandex(page, target, filters, sentIds, bot) {
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  const ads = await page.evaluate(() => {
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
  return emitFirstMatching(target.label, 'yandex', ads, filters, sentIds, bot);
}

async function parseDomclick(page, target, filters, sentIds, bot) {
  await page.goto('https://domclick.ru/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://domclick.ru/' });
  await page.waitForTimeout(2500);
  const ads = await page.evaluate(() => {
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
  return emitFirstMatching(target.label, 'domclick', ads, filters, sentIds, bot);
}

async function processTarget(target, filters, sentIds, bot) {
  console.log(`Обработка: ${target.label}`);
  if (target.type === 'avito' || target.type === 'cian') {
    const { browser, page } = await launchPuppeteer(target.type);
    try {
      if (target.type === 'avito') return await parseAvito(page, target, filters, sentIds, bot);
      return await parseCian(page, target, filters, sentIds, bot);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  const { browser, context, page } = await launchPlaywright(target.type);
  try {
    if (target.type === 'yandex') return await parseYandex(page, target, filters, sentIds, bot);
    return await parseDomclick(page, target, filters, sentIds, bot);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function oneRun(sentIds, bot) {
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
      await processTarget(target, filters, sentIds, bot);
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
  if (process.env.SINGLE_RUN === '1') {
    await oneRun(sentIds, bot);
    return;
  }
  while (!stopping) {
    await oneRun(sentIds, bot);
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
