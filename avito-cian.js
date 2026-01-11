
const puppeteer = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const { anonymizeProxy } = require('proxy-chain');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os');


let playwright = null;
try {
  playwright = require('playwright');
} catch (e) {
  console.log('⚠️ Playwright не установлен. Установите: npm install playwright');
}

const SENT_FILE = path.join(__dirname, 'sent-ids.txt');

function loadSentIds() {
  if (!fs.existsSync(SENT_FILE)) return new Set();
  return new Set(fs.readFileSync(SENT_FILE, 'utf8').split('\n').filter(Boolean));
}

function saveSentId(id) { 
  fs.appendFileSync(SENT_FILE, id + '\n');
}

puppeteer.use(stealthPlugin());

const TELEGRAM_BOT_TOKEN = process.env.TG_BOT_TOKEN || '5885184228:AAHWdBoxm-jIn-1xwyGWudn4IDqm3pACRrI';
const TELEGRAM_CHAT_ID = process.env.TG_CHAT_ID || '5761109418';
const MAX_PER_SOURCE = 1;


function getChromePath() {
  const platform = os.platform();
  
  if (platform === 'darwin') {
    
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else if (platform === 'linux') {
    
    const possiblePaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium'
    ];
    
    for (const chromePath of possiblePaths) {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    }
    
    
    return undefined;
  } else if (platform === 'win32') {
    
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  
  return undefined;
}

const CHROME_PATH = process.env.CHROME_PATH || getChromePath();
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const PROXY_MODE = process.env.PROXY_MODE || 'off';


const proxyList = [ 
  
  { url: 'http://iparchitect_43669_15_08_25:TSHRb8RFHFdznTz8RB@188.143.169.27:30149' },
  
  { url: 'socks5://iparchitect_43669_15_08_25:TSHRb8RFHFdznTz8RB@188.143.169.27:40149' },
  
  { url: 'http://LdlgSr3R4:ufKRLJ13y@193.8.164.45:63142' }
];

const RUN_INTERVAL_MS_MIN = 50000;   
const RUN_INTERVAL_MS_MAX = 100000;  
const PAGE_JITTER_MIN = 30000;
const PAGE_JITTER_MAX = 60000;
const GOTO_TIMEOUT_MS = 60000;
const POST_GOTO_PAUSE_MS_MIN = 20000;
const POST_GOTO_PAUSE_MS_MAX = 50000;
const RETRIES_ON_BLOCK = 2;

const WORK_HOURS = { from: 8, to: 23 };

const SEARCH_URLS = [
  
  {
    type: 'cian',
    url: 'https://www.cian.ru/cat.php?currency=2&deal_type=rent&engine_version=2&maxprice=35000&minprice=14000&offer_type=flat&region=1&room0=1&sort=creation_date_desc&type=4',
    label: 'ЦИАН'
  },
  {
    type: 'avito',
    url: 'https://www.avito.ru/moskva/komnaty/sdam/na_dlitelnyy_srok-ASgBAgICAkSQA74QqAn2YA?context=H4sIAAAAAAAA_wEjANz_YToxOntzOjg6ImZyb21QYWdlIjtzOjc6ImNhdGFsb2ciO312FITcIwAAAA&f=ASgBAgECA0SQA74QqAn2YPbiDqzx2wIBRfwHFXsiZnJvbSI6MTQsInRvIjpudWxsfQ&s=104',
    label: 'Комната'
  },
  {
    type: 'avito',
    url: 'https://www.avito.ru/moskva/kvartiry/sdam-ASgBAgICAUSSA8gQ?context=H4sIAAAAAAAA_wEjANz_YToxOntzOjg6ImZyb21QYWdlIjtzOjc6ImNhdGFsb2ciO312FITcIwAAAA&f=ASgBAgECAkSSA8gQiqcVtp2SAwFFxpoMFXsiZnJvbSI6MCwidG8iOjQwMDAwfQ&s=104&user=1',
    label: 'Квартира'
  },
  {
    type: 'yandex',
    url: 'https://realty.yandex.ru/moskva_i_moskovskaya_oblast/snyat/kvartira/?priceMax=40000&mapPolygon=55.91853%2C37.45427%3B55.86992%2C37.30459%3B55.79417%2C37.24141%3B55.71208%2C37.25103%3B55.61738%2C37.32793%3B55.55048%2C37.48586%3B55.54114%2C37.75777%3B55.60649%2C37.88961%3B55.66941%2C37.95553%3B55.75625%2C37.96514%3B55.85061%2C37.88137%3B55.8869%2C37.80309%3B55.91236%2C37.67949%3B55.92085%2C37.42955&sort=DATE_DESC',
    label: 'Яндекс Недвижимость'
  },
  {
    type: 'domclick',
    url: 'https://domclick.ru/search?deal_type=rent&category=living&offer_type=flat&offer_type=room&aids=2299&rent_price__lte=40000&sort=published&sort_dir=desc&build_year__gte=1995&time_on_foot__lte=30&offset=0',
    label: 'ДомКлик'
  },
];

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fixAvitoUrl(url) {
  return url.replace('m.avito.ru', 'www.avito.ru');
}

function extractAvitoId(url) {
  const match = url.match(/_(\d+)(?:\?|$)/);
  return match ? `avito_${match[1]}` : null;
}

function extractCianId(url) {
  const match = url.match(/flat\/(\d+)/);
  return match ? `cian_${match[1]}` : null;
}

function extractYandexId(url) {
  
  const patterns = [
    /\/offer\/(\d+)/,           
    /\/realty\/(\d+)/,          
    /\/moskva\/(\d+)/,          
    /\/kvartira\/(\d+)/,        
    /[?&]id=(\d+)/,             
    /[?&]offer_id=(\d+)/        
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return `yandex_${match[1]}`;
    }
  }
  
  
  const urlHash = url.split('/').pop().split('?')[0];
  if (urlHash && urlHash.length > 5) {
    return `yandex_${urlHash}`;
  }
  
  return null;
}

function extractDomclickId(url) {
  const m = url.match(/card\/rent__[^_]+__([0-9]+)/);
  return m ? `domclick_${m[1]}` : null;
}

async function sendToTelegram(bot, chatId, message) {
  try {
    if (process.env.SKIP_TELEGRAM === '1') {
      console.log(`TELEGRAM SKIPPED: ${message}`);
      return;
    }
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Ошибка Telegram:', e.message);
  }
}

function isWithinAllowedTimeRange() {
  const now = new Date();
  const hour = now.getHours();
  const isWorking = hour >= WORK_HOURS.from && hour < WORK_HOURS.to;
  
  if (!isWorking) {
    const nextStart = new Date(now);
    if (hour < WORK_HOURS.from) {
      
      nextStart.setHours(WORK_HOURS.from, 0, 0, 0);
    } else {
      
      nextStart.setDate(nextStart.getDate() + 1);
      nextStart.setHours(WORK_HOURS.from, 0, 0, 0);
    }
    
    const timeUntilStart = Math.ceil((nextStart - now) / (1000 * 60 * 60));
    console.log(`⏰ Вне рабочего времени (${hour}:00). Следующий запуск в ${WORK_HOURS.from}:00`);
    if (hour >= WORK_HOURS.to) {
      console.log(`🌙 Скрипт будет работать завтра с ${WORK_HOURS.from}:00 до ${WORK_HOURS.to}:00`);
    } else {
      console.log(`🌅 Скрипт будет работать сегодня с ${WORK_HOURS.from}:00 до ${WORK_HOURS.to}:00`);
    }
  }
  
  return isWorking;
}

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
];

const randomUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

let proxyIndex = 0;
function getNextProxy() {
  const p = proxyList[proxyIndex];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  
  
  let proxyInfo = p.url;
  if (p.url.includes('@')) {
    const [auth, host] = p.url.split('@');
    proxyInfo = `${host} (${auth.split(':')[0]}...)`;
  }
  
  console.log(`🔄 Используем прокси ${proxyIndex}/${proxyList.length}: ${proxyInfo}`);
  return p.url;
}

async function setPageFingerprint(page) {
  const width = 1200 + rand(-120, 240);
  const height = 800 + rand(-80, 160);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'upgrade-insecure-requests': '1',
    'accept-language': 'ru-RU,ru;q=0.9',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

async function humanize(page) {
  try {
    await page.mouse.move(rand(50, 400), rand(50, 300), { steps: rand(10, 30) });
    await sleep(rand(500, 1200));
    await page.mouse.move(rand(300, 900), rand(200, 700), { steps: rand(10, 30) });
    await page.evaluate(() => window.scrollBy(0, Math.floor(200 + Math.random() * 600)));
    await sleep(rand(700, 1600));
  } catch (_) { }
}

async function detectCaptchaOrBlock(page, opts = {}) {
  const { readySelector } = opts;
  const url = page.url();
  if (/blocked|captcha|forbidden|accessdenied/i.test(url)) return true;
  const visibleText = await page.evaluate(() => document.body?.innerText?.slice(0, 20000) || '');
  const vt = visibleText.toLowerCase();
  const markers = ['доступ ограничен', 'проблема с ip', 'вы робот', 'подтвердите, что вы не робот', 'captcha'];
  if (markers.some(m => vt.includes(m))) return true;
  if (readySelector) {
    const ready = await page.$(readySelector);
    if (ready) return false;
  } else {
    const hasItems = await page.$('div[data-marker="item"]');
    const hasCatalog = await page.$('[data-marker="catalog"]');
    if (!hasItems && !hasCatalog && vt.length < 5000) return true;
  }
  return false;
}

async function maybeClickContinue(page) {
  try {
    const clicked = await page.evaluate(() => {
      const substrings = ['продолжить'];
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const t = (btn.innerText || '').toLowerCase();
        if (substrings.some(s => t.includes(s))) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => { });
      await sleep(rand(1200, 2500));
      return true;
    }
  } catch (_) { }
  return false;
}

async function dismissOverlays(page) {
  try {
    const clickedCookies = await page.evaluate(() => {
      const substrings = ['хорошо', 'принять', 'accept', 'ok'];
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const t = (btn.innerText || '').toLowerCase();
        if (substrings.some(s => t.includes(s))) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clickedCookies) {
      await page.waitForTimeout(500);
    }
  } catch (_) { }
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Закрыть"], button[aria-label="Close"]');
    if (btn) btn.click();
  }).catch(() => { });
}

async function safeGoto(page, url, opts = {}) {
  const { readySelector } = opts;
  for (let attempt = 0; attempt <= RETRIES_ON_BLOCK; attempt++) {
    try {
      const referer = (() => { try { return new URL(url).origin; } catch (_) { return undefined; } })();
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS, referer });
      const status = resp && resp.status ? resp.status() : 200;
      await sleep(rand(POST_GOTO_PAUSE_MS_MIN, POST_GOTO_PAUSE_MS_MAX));
      await dismissOverlays(page);
      if (status === 403 || status === 429) {
        if (attempt < RETRIES_ON_BLOCK) {
          await sleep(rand(3000, 6000));
          continue;
        }
        return false;
      }
      if (readySelector) {
        await page.waitForSelector(readySelector, { timeout: 10000 }).catch(() => { });
      } else {
        await page.waitForSelector('div[data-marker="item"], [data-marker="catalog"]', { timeout: 7000 }).catch(() => { });
      }
      if (await detectCaptchaOrBlock(page, { readySelector })) {
        const clicked = await maybeClickContinue(page);
        await sleep(rand(1200, 2500));
        if (clicked && !(await detectCaptchaOrBlock(page, { readySelector }))) return true;
        if (attempt < RETRIES_ON_BLOCK) {
          await sleep(rand(2500, 5000));
          continue;
        }
        return false;
      }
      return true;
    } catch (e) {
      if (attempt < RETRIES_ON_BLOCK) {
        await sleep(rand(2000, 4000));
        continue;
      }
      console.error('❌ GOTO ошибка:', e.message);
      return false;
    }
  }
  return false;
}

async function parseAvito(page, url, label, bot, chatId, sentIds) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    await page.waitForSelector('[data-marker="item"] a[itemprop="url"], a[itemprop="url"]', { timeout: 30000 }).catch(() => {});
  } catch (error) {
    console.error('❌ Ошибка загрузки страницы Avito:', error.message);
    return;
  }
  let links = [];
  try {
    links = await page.$$eval('a[itemprop="url"]', elements => elements.map(el => el.href));
  } catch (_) {}
  if (!links || links.length === 0) {
    
    try {
      links = await page.$$eval('[data-marker="item"] a[href*="/moskva/"]', els => els.map(a => a.href));
    } catch (_) {}
  }
  links = (links || []).filter(href => typeof href === 'string' && href.includes('/moskva/'));
  const firstLink = links[0];
  if (!firstLink) return;
  const id = extractAvitoId(firstLink);
  if (!id || sentIds.has(id)) return;
  sentIds.add(id);
  saveSentId(id);
  const message = `🏠 <b>${label}</b>\n🔗 ${firstLink}`;
  await sendToTelegram(bot, chatId, message);
}

async function parseCian(page, url, label, bot, chatId, sentIds) {
  const ok = await safeGoto(page, url, { readySelector: 'article[data-name="CardComponent"]' });
  if (!ok) return;
  await humanize(page);
  let first = await page.$('article[data-name="CardComponent"]');
  if (!first) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
    await sleep(rand(1200, 2500));
    first = await page.$('article[data-name="CardComponent"]');
  }
  if (!first) return;
  const ad = await page.$$eval('article[data-name="CardComponent"]', nodes => {
    const card = nodes[0];
    if (!card) return null;
    const href = card.querySelector('a[href*="/rent/flat/"]')?.href?.split('?')[0];
    const title = card.querySelector('[data-mark="OfferTitle"]')?.textContent?.trim();
    const price = card.querySelector('[data-mark="MainPrice"]')?.textContent?.trim();
    const location = card.querySelector('div[data-name="SpecialGeo"]')?.textContent?.trim();
    const desc = card.querySelector('[data-name="Description"]')?.textContent?.trim();
    return { href, title, price, location, desc };
  }).catch(() => null);
  if (process.env.DEBUG_LOG === '1') {
    console.log(`CIAN first card:`, ad);
  }
  if (!ad?.href) return;
  const id = extractCianId(ad.href);
  if (!id || sentIds.has(id)) return;
  sentIds.add(id);
  saveSentId(id);
  const msg = `🏢 <b>${ad.title || label}</b>\n\n💰 ${ad.price || ''}\n📍 ${ad.location || ''}\n\n${ad.desc || ''}\n🔗 ${ad.href}`;
  await sendToTelegram(bot, chatId, msg);
}

async function parseYandex(page, url, label, bot, chatId, sentIds) {
  try {
    console.log(`🏠 Парсим Yandex Realty: ${url}`);
    
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    
    const hasCaptcha = await page.evaluate(() => {
      const content = document.body.innerText;
      return content.includes('Подтвердите, что запросы отправляли вы, а не робот') ||
             content.includes('SmartCaptcha by Yandex Cloud') ||
             content.includes('запросы с вашего устройства похожи на автоматические');
    });
    
    if (hasCaptcha) {
      console.log('🚨 Обнаружена капча на Yandex Realty');
      return;
    }
    
    
    await page.waitForSelector(
      'li.OffersSerpItem a.OffersSerpItem__link, li[class*="OffersSerpItem"] a.OffersSerpItem__link, [data-test="OffersSerpItem"] a.OffersSerpItem__link',
      { timeout: 10000 }
    );

    const ad = await page.evaluate(() => {
      const anchor = document.querySelector(
        'li.OffersSerpItem a.OffersSerpItem__link, li[class*="OffersSerpItem"] a.OffersSerpItem__link, [data-test="OffersSerpItem"] a.OffersSerpItem__link'
      );
      if (!anchor) return null;

      const card = anchor.closest('li') || anchor.closest('[data-test="OffersSerpItem"]') || anchor.closest('.OffersSerpItem');
      const href = (anchor.href || anchor.getAttribute('href') || '').split('?')[0];

      const pickText = (selectors) => {
        for (const sel of selectors) {
          const el = card?.querySelector(sel);
          if (el && el.textContent) return el.textContent.trim();
        }
        return '';
      };

      const title = pickText([
        '.OffersSerpItemTitle__title',
        '.OffersSerpItem__titleLink',
        '[data-testid="offer-title"]',
        '.OfferCard__title',
        '[class*="title"]',
        'h3, h4, h5',
        '.OffersList__title'
      ]);

      const price = pickText([
        '.OffersSerpItem__price',
        '.OfferPriceLabel__priceWithTrend',
        '[data-testid="offer-price"]',
        '.OfferCard__price',
        '[class*="price"]',
        '.OffersList__price'
      ]);

      const location = pickText([
        '.OffersSerpItem__location',
        '.SnippetLocation__container',
        '.MetroWithTime',
        '.AddressWithGeoLinks__addressContainer',
        '[data-testid="offer-location"]',
        '.OfferCard__location',
        '[class*="location"]',
        '.OffersList__location'
      ]);

      const desc = pickText([
        '.OffersSerpItem__description',
        '[data-testid="offer-description"]',
        '.OfferCard__description',
        '[class*="description"]',
        '.OffersList__description',
        'p'
      ]);

      return { href, title, price, location, desc };
    });
    
    if (process.env.DEBUG_LOG === '1') {
      console.log(`Yandex first card:`, ad);
    }
    
    if (!ad?.href) {
      console.log('❌ Не удалось извлечь ссылку из карточки Yandex');
      return;
    }
    
    const id = extractYandexId(ad.href);
    if (!id) {
      console.log('❌ Не удалось извлечь ID из ссылки:', ad.href);
      return;
    }
    
    
    if (sentIds.has(id)) {
      console.log('✅ Объявление уже отправлено:', id);
      return;
    }
    
    
    sentIds.add(id);
    saveSentId(id);
    
    
    const msg = `🏠 <b>${ad.title || label}</b>\n\n💰 ${ad.price || 'Цена не указана'}\n📍 ${ad.location || 'Адрес не указан'}\n\n${ad.desc || 'Описание не указано'}\n🔗 ${ad.href}`;
    
    
    await sendToTelegram(bot, chatId, msg);
    
    console.log(`✅ Yandex объявление отправлено в Telegram: ${id}`);
    console.log(`📝 Заголовок: ${ad.title || 'Не указан'}`);
    console.log(`💰 Цена: ${ad.price || 'Не указана'}`);
    console.log(`📍 Локация: ${ad.location || 'Не указана'}`);
    
  } catch (error) {
    console.error(`❌ Ошибка парсинга Yandex: ${error.message}`);
    
  }
}

async function parseDomclick(page, url, label, bot, chatId, sentIds) {
  try {
    console.log(`🏠 Парсим ДомКлик: ${url}`);
    
    await page.goto('https://domclick.ru/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.mouse.move(200, 200).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 300)).catch(() => {});

    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://domclick.ru/' });
    await page.waitForTimeout(1500);

    
    const is403 = await page.evaluate(() => /403\s+Доступ\s+запрещен/i.test(document.body.innerText));
    if (is403) {
      console.log('🚫 DomClick вернул 403. Пробуем перезагрузку с referer.');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      const is403again = await page.evaluate(() => /403\s+Доступ\s+запрещен/i.test(document.body.innerText));
      if (is403again) {
        return;
      }
    }

    
    await page.waitForSelector('a.Q7TuMJ[href*="/card/"]', { timeout: 15000 });
    const ad = await page.evaluate(() => {
      const anchor = document.querySelector('a.Q7TuMJ[href*="/card/"]');
      if (!anchor) return null;
      const href = anchor.href.split('?')[0];
      const title = anchor.getAttribute('aria-label') || '';

      
      const parent = anchor.closest('article, div, li') || document;
      const priceEl = parent.querySelector('[class*="price" i], [data-test*="price" i]');
      const locationEl = parent.querySelector('[class*="address" i], [class*="location" i]');
      const descEl = parent.querySelector('p');

      return {
        href,
        title,
        price: priceEl?.textContent?.trim() || '',
        location: locationEl?.textContent?.trim() || '',
        desc: descEl?.textContent?.trim() || ''
      };
    });

    if (!ad?.href) return;
    const id = extractDomclickId(ad.href);
    if (!id) return;
    if (sentIds.has(id)) return;
    sentIds.add(id);
    saveSentId(id);

    const msg = `🏡 <b>${ad.title || label}</b>\n\n💰 ${ad.price || ''}\n📍 ${ad.location || ''}\n\n${ad.desc || ''}\n🔗 ${ad.href}`;
    await sendToTelegram(bot, chatId, msg);
    console.log(`✅ DomClick объявление отправлено: ${id}`);
  } catch (e) {
    console.error('❌ Ошибка DomClick:', e.message);
  }
}

let runCounter = 0;
async function launchBrowserWithMode(siteType = 'default') {
  
  let useProxy = false;
  
  if (siteType === 'cian') {
    
    useProxy = true;
    console.log(`🌐 Циан: принудительно используем прокси`);
  } else if (siteType === 'avito') {
    
    useProxy = false;
    console.log(`🏠 Авито: работаем без прокси`);
  } else {
    
    useProxy = (PROXY_MODE === 'on') || (PROXY_MODE === 'alternate' && (runCounter % 2 === 1));
  }
  
  let launchArgs = [
    '--no-sandbox', 
    '--disable-setuid-sandbox', 
    '--disable-blink-features=AutomationControlled', 
    '--lang=ru-RU,ru',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-plugins',
    '--disable-images',
    '--ignore-certificate-errors', 
    '--disable-web-security',      
    '--allow-running-insecure-content' 
  ];
  
  let proxyLog = '🚫 Прокси: OFF';
  
  if (useProxy) {
    try {
      const proxy = getNextProxy();
      const anonymized = await anonymizeProxy(proxy);
      launchArgs.push(`--proxy-server=${anonymized}`);
      
      
      let proxyInfo = proxy;
      if (proxy.includes('@')) {
        const [auth, host] = proxy.split('@');
        proxyInfo = `${host} (${auth.split(':')[0]}...)`;
      }
      
      proxyLog = `🌐 Прокси: ${proxyInfo}`;
      console.log(`✅ Прокси настроен: ${anonymized}`);
    } catch (error) {
      console.error(`❌ Ошибка настройки прокси:`, error.message);
      console.log(`🔄 Продолжаем без прокси`);
      useProxy = false;
    }
  }
  
  const ua = randomUA();
  console.log(`${proxyLog} | 🎭 UA: ${ua}`);
  
  
  const launchOptions = {
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    args: launchArgs,
    protocolTimeout: 120000
  };
  
  
  if (CHROME_PATH) {
    launchOptions.executablePath = CHROME_PATH;
    console.log(`🔧 Используем Chrome: ${CHROME_PATH}`);
  } else {
    console.log(`🔧 Chrome не найден, используем встроенный`);
  }
  
  const browser = await puppeteer.launch(launchOptions);
  
  const page = await browser.newPage();
  
  try {
    await page.setDefaultTimeout(60000);
    await page.setDefaultNavigationTimeout(60000);
  } catch (_) {}
  await page.setUserAgent(ua);
  await setPageFingerprint(page);
  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  
  page.on('request', (req) => {
    try {
      if (typeof req.isInterceptResolutionHandled === 'function' && req.isInterceptResolutionHandled()) return;
      const type = req.resourceType();
      const url = req.url();
      const isAvito = /\.avito\.ru\b/.test(url);
      const isCian = /\.(cian|cdn-cian)\./.test(url);
      
      if (['image', 'font', 'media'].includes(type)) return req.abort().catch(() => { });
      if (type === 'stylesheet') {
        if (isAvito) return req.abort().catch(() => { });
        if (isCian) return req.continue().catch(() => { });
        return req.abort().catch(() => { });
      }
      return req.continue().catch(() => { });
    } catch (_) { }
  });
  
  return { browser, page };
}

async function launchPlaywrightForYandex(siteType = 'default') {
  try {
    
    const platform = os.platform();
    const shouldHeadless = (() => {
      if (process.env.PW_HEADLESS === '0') return false;
      return true; 
    })();

    const launchCommon = {
      headless: shouldHeadless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins'
      ]
    };

    if (siteType === 'yandex' || siteType === 'domclick') {
        try {
            const proxyUrl = getNextProxy();
            const url = new URL(proxyUrl);
            const proxyInfo = `${url.hostname}:${url.port} (${url.username ? url.username.substring(0,5) : 'no_auth'}...)`;
            
            launchCommon.proxy = {
                server: url.host,
                username: url.username,
                password: url.password
            };
            console.log(`✅ Playwright прокси настроен: ${proxyInfo}`);
        } catch (error) {
            console.error(`❌ Ошибка настройки прокси для Playwright:`, error.message);
        }
    }

    let browser;
    if (platform === 'linux') {
      
      const chromePathCandidates = [
        process.env.CHROME_PATH,
        CHROME_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium'
      ].filter(Boolean);

      let foundPath = undefined;
      for (const p of chromePathCandidates) {
        try { if (p && fs.existsSync(p)) { foundPath = p; break; } } catch (_) {}
      }

      if (foundPath) {
        browser = await playwright.chromium.launch({ ...launchCommon, executablePath: foundPath });
      } else {
        
        browser = await playwright.chromium.launch(launchCommon);
      }
    } else {
      
      browser = await playwright.chromium.launch(launchCommon);
    }

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      ignoreHTTPSErrors: true, 
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.8,en-US;q=0.5,en;q=0.3',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const page = await context.newPage();

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
    });

    return { browser, page, context };
  } catch (error) {
    console.error(`❌ Ошибка запуска Playwright: ${error.message}`);
    console.error('💡 Если ошибка связана с отсутствием браузера, выполните на сервере: npx --yes playwright install chromium');
    console.error('💡 Если нет X-сервера, запускайте headless (по умолчанию на Linux без DISPLAY) или используйте: xvfb-run -a node avito-cian.js');
    throw error;
  }
}

async function main() {
  
  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
    polling: false,
  });
  
  const sentIds = loadSentIds();
  
  
  console.log(`⏰ Время работы скрипта: с ${WORK_HOURS.from}:00 до ${WORK_HOURS.to}:00`);
  console.log(`📅 Текущее время: ${new Date().toLocaleString('ru-RU')}`);
  
  async function oneRun(sentIds) {
    if (!isWithinAllowedTimeRange()) {
      console.log(`💤 Ожидание рабочего времени...`);
      return;
    }
    
    runCounter++;
    console.log(`\n🚀 Запуск #${runCounter} в ${new Date().toLocaleTimeString('ru-RU')}`);
    
    
    for (const { type, url, label } of SEARCH_URLS) {
      console.log(`\n📋 Обработка: ${label} (${type})`);
      
      if (type === 'cian') {
        
        console.log(`🌐 Циан: используем прокси для обхода VPN блокировки`);
        const { browser, page } = await launchBrowserWithMode('cian');
        try {
          await parseCian(page, url, label, bot, TELEGRAM_CHAT_ID, sentIds);
        } finally {
          await browser.close().catch(() => { });
        }
      } else if (type === 'avito') {
        
        console.log(`🏠 Авито: работаем без прокси`);
        const { browser, page } = await launchBrowserWithMode('avito');
        try {
          await parseAvito(page, url, label, bot, TELEGRAM_CHAT_ID, sentIds);
        } finally {
          await browser.close().catch(() => { });
        }
      } else if (type === 'yandex') {
        
        if (!playwright) {
          console.log('❌ Playwright не установлен для Yandex Realty');
          continue;
        }
        console.log(`🏠 Яндекс Недвижимость: используем Playwright`);
        const { browser, page, context } = await launchPlaywrightForYandex('yandex');
        try {
          await parseYandex(page, url, label, bot, TELEGRAM_CHAT_ID, sentIds);
        } finally {
          await context.close().catch(() => { });
          await browser.close().catch(() => { });
        }
      } else if (type === 'domclick') {
        
        if (!playwright) {
          console.log('❌ Playwright не установлен для ДомКлик');
          continue;
        }
        console.log(`🏠 ДомКлик: используем Playwright`);
        const { browser, page, context } = await launchPlaywrightForYandex('domclick');
        try {
          await parseDomclick(page, url, label, bot, TELEGRAM_CHAT_ID, sentIds);
        } finally {
          await context.close().catch(() => { });
          await browser.close().catch(() => { });
        }
      }
      
      const wait = rand(PAGE_JITTER_MIN, PAGE_JITTER_MAX);
      console.log(`⏳ Пауза ${Math.round(wait / 1000)}с перед следующим сайтом`);
      await sleep(wait);
    }
  }
  
  if (process.env.SINGLE_RUN === '1') {
    await oneRun(sentIds);
    return;
  } else {
    await oneRun(sentIds);
    
    while (true) {
      const wait = rand(RUN_INTERVAL_MS_MIN, RUN_INTERVAL_MS_MAX);
      const nextRunTime = new Date(Date.now() + wait);
      console.log(`\n⏳ Следующий прогон через ${Math.round(wait / 1000)} сек. (в ${nextRunTime.toLocaleTimeString('ru-RU')})`);
      await sleep(wait);
      await oneRun(sentIds);
    }
  }
}

process.on('SIGINT', () => {
  console.log('🛑 Завершение по SIGINT');
  process.exit(0);
});

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});