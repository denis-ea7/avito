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

function formatMessage(label, ad) {
  const desc = ad.desc && ad.desc.length > 1400 ? `${ad.desc.slice(0, 1400)}...` : ad.desc;
  return [
    `🏠 <b>${ad.title || label}</b>`,
    ad.price ? `💰 ${ad.price}` : '',
    ad.location ? `📍 ${ad.location}` : '',
    desc ? `\n${desc}` : '',
    `🔗 ${ad.href}`
  ].filter(Boolean).join('\n');
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
            content: 'Ты фильтруешь объявления аренды недвижимости. Ответь только JSON вида {"match":true,"reason":"..."}. Учитывай количество комнат, общую площадь, площадь комнаты, залог, посредника, этаж, этажность, год, метро, цену. Если данных не хватает для включенного строгого фильтра, match=false.'
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

async function emitFirstMatching(label, source, ads, filters, sentIds, bot, propertyType, enrichAd, maxEnriched = 6) {
  let enrichedCount = 0;
  for (const ad of ads) {
    if (!ad?.href) continue;
    const id = extractListingId(source, ad.href);
    if (!id || sentIds.has(id)) continue;
    let normalizedAd = { ...ad, propertyType };
    let decision = filterDecision(normalizedAd, filters);
    if (((!decision.match && decision.detailsUseful) || (decision.match && filters.aiEnabled)) && enrichAd && enrichedCount < maxEnriched) {
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
    await sendToTelegram(bot, TELEGRAM_CHAT_ID, formatMessage(label, normalizedAd));
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
    const detail = await page.evaluate(() => document.body?.innerText?.slice(0, 15000) || '').catch(() => '');
    return { ...ad, desc: [ad.desc, detail].filter(Boolean).join('\n') };
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

async function parseAvito(browser, page, target, filters, sentIds, bot) {
  const ok = await safeGoto(page, target.url, 'a[href*="/kvartiry/"], a[href*="/komnaty/"]');
  if (!ok) return false;
  let ads = await page.evaluate(() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/kvartiry/"], a[href*="/komnaty/"]'))
      .map((anchor) => anchor.href || '')
      .filter((href) => /_\d+(?:\?|$)/.test(href))
      .map((href) => href.split('#')[0])
      .filter((href) => {
        const key = href.split('?')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 15)
      .map((href) => {
        const pathname = new URL(href).pathname;
        const rawTitle = decodeURIComponent(pathname.split('/').pop() || '').replace(/_\d+$/, '').replace(/[_-]+/g, ' ').trim();
        return { href, title: rawTitle, price: '', location: '', desc: rawTitle };
      });
  }).catch(() => []);
  console.log(`Авито найдено карточек: ${ads.length}`);
  return emitFirstMatching(target.label, 'avito', ads, filters, sentIds, bot, target.propertyType, (ad) => enrichPuppeteerAd(browser, ad, 'avito'), 15);
}

async function parseCian(browser, page, target, filters, sentIds, bot) {
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
  return emitFirstMatching(target.label, 'cian', ads, filters, sentIds, bot, target.propertyType, (ad) => enrichPuppeteerAd(browser, ad, 'cian'));
}

async function parseYandex(context, page, target, filters, sentIds, bot) {
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
  return emitFirstMatching(target.label, 'yandex', ads, filters, sentIds, bot, target.propertyType, (ad) => enrichPlaywrightAd(context, ad));
}

async function parseDomclick(context, page, target, filters, sentIds, bot) {
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
  return emitFirstMatching(target.label, 'domclick', ads, filters, sentIds, bot, target.propertyType, (ad) => enrichPlaywrightAd(context, ad));
}

async function processTarget(target, filters, sentIds, bot) {
  console.log(`Обработка: ${target.label}`);
  if (target.type === 'avito' || target.type === 'cian') {
    const { browser, page, profileDir } = await launchPuppeteer(target.type);
    try {
      if (target.type === 'avito') return await parseAvito(browser, page, target, filters, sentIds, bot);
      return await parseCian(browser, page, target, filters, sentIds, bot);
    } finally {
      await closePuppeteer(browser, profileDir);
    }
  }
  const { browser, context, page } = await launchPlaywright(target.type);
  try {
    if (target.type === 'yandex') return await parseYandex(context, page, target, filters, sentIds, bot);
    return await parseDomclick(context, page, target, filters, sentIds, bot);
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
