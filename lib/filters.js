const fs = require('fs');
const path = require('path');

const defaultConfig = {
  enabled: true,
  sources: ['avito', 'cian', 'yandex', 'domclick'],
  propertyTypes: ['room', 'flat'],
  rooms: [1],
  priceMin: 14000,
  priceMax: 40000,
  totalAreaMin: '',
  totalAreaMax: '',
  roomAreaMin: '',
  roomAreaMax: '',
  metroMinutesMin: '',
  metroMinutesMax: 30,
  metroMode: 'any',
  buildYearMin: 1995,
  buildYearMax: '',
  floorMin: '',
  floorMax: '',
  floorsTotalMin: '',
  floorsTotalMax: '',
  sellerType: 'any',
  deposit: 'any',
  aiEnabled: false,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-chat',
  deepseekApiKey: '',
  autostart: true
};

const sourceNames = {
  avito: 'Авито',
  cian: 'ЦИАН',
  yandex: 'Яндекс Недвижимость',
  domclick: 'ДомКлик'
};

const typeNames = {
  room: 'Комната',
  flat: 'Квартира'
};

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function toNumberArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function normalizeConfig(input = {}) {
  const config = { ...defaultConfig, ...input };
  config.sources = Array.isArray(config.sources) && config.sources.length ? config.sources.filter((source) => sourceNames[source]) : defaultConfig.sources;
  config.propertyTypes = Array.isArray(config.propertyTypes) && config.propertyTypes.length ? config.propertyTypes.filter((type) => typeNames[type]) : defaultConfig.propertyTypes;
  config.rooms = toNumberArray(config.rooms);
  config.priceMin = toNumber(config.priceMin);
  config.priceMax = toNumber(config.priceMax);
  config.totalAreaMin = toNumber(config.totalAreaMin !== undefined ? config.totalAreaMin : config.areaMin);
  config.totalAreaMax = toNumber(config.totalAreaMax !== undefined ? config.totalAreaMax : config.areaMax);
  config.roomAreaMin = toNumber(config.roomAreaMin);
  config.roomAreaMax = toNumber(config.roomAreaMax);
  if (config.roomAreaMin !== '' && config.roomAreaMin <= 1) config.roomAreaMin = '';
  config.metroMinutesMin = toNumber(config.metroMinutesMin);
  config.metroMinutesMax = toNumber(config.metroMinutesMax);
  config.buildYearMin = toNumber(config.buildYearMin);
  config.buildYearMax = toNumber(config.buildYearMax);
  config.floorMin = toNumber(config.floorMin);
  config.floorMax = toNumber(config.floorMax);
  config.floorsTotalMin = toNumber(config.floorsTotalMin);
  config.floorsTotalMax = toNumber(config.floorsTotalMax);
  config.metroMode = ['any', 'foot', 'transport'].includes(config.metroMode) ? config.metroMode : 'any';
  config.sellerType = ['any', 'owner', 'agent'].includes(config.sellerType) ? config.sellerType : 'any';
  config.deposit = ['any', 'yes', 'no'].includes(config.deposit) ? config.deposit : 'any';
  config.aiEnabled = Boolean(config.aiEnabled);
  config.aiProvider = 'deepseek';
  config.aiModel = String(config.aiModel || defaultConfig.aiModel).trim() || defaultConfig.aiModel;
  config.deepseekApiKey = String(config.deepseekApiKey || '').trim();
  config.enabled = Boolean(config.enabled);
  config.autostart = Boolean(config.autostart);
  delete config.areaMin;
  delete config.areaMax;
  delete config.city;
  delete config.query;
  delete config.deepseekApiKeySet;
  return config;
}

function readConfig(filePath = path.join(__dirname, '..', 'filters.json')) {
  try {
    if (!fs.existsSync(filePath)) return normalizeConfig(defaultConfig);
    return normalizeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (e) {
    return normalizeConfig(defaultConfig);
  }
}

function writeConfig(filePath, config) {
  const normalized = normalizeConfig(config);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function appendIfNumber(params, key, value) {
  if (value !== '') params.set(key, String(value));
}

function cianUrl(config, propertyType) {
  const params = new URLSearchParams({
    currency: '2',
    deal_type: 'rent',
    engine_version: '2',
    offer_type: 'flat',
    sort: 'creation_date_desc',
    type: '4'
  });
  params.append('region', '1');
  params.append('region', '4593');
  appendIfNumber(params, 'minprice', config.priceMin);
  appendIfNumber(params, 'maxprice', config.priceMax);
  appendIfNumber(params, 'mintarea', config.totalAreaMin);
  appendIfNumber(params, 'maxtarea', config.totalAreaMax);
  appendIfNumber(params, 'minfloor', config.floorMin);
  appendIfNumber(params, 'maxfloor', config.floorMax);
  appendIfNumber(params, 'min_house_year', config.buildYearMin);
  appendIfNumber(params, 'max_house_year', config.buildYearMax);
  if (propertyType === 'room') params.set('room0', '1');
  if (propertyType === 'flat' && config.rooms.length) {
    config.rooms.forEach((room) => params.set(`room${room}`, '1'));
  }
  return `https://www.cian.ru/cat.php?${params.toString()}`;
}

function avitoUrl(config, propertyType) {
  const pathPart = propertyType === 'room' ? 'komnaty' : 'kvartiry/sdam-ASgBAgICAUSSA8gQ';
  const params = new URLSearchParams({ s: '104' });
  if (propertyType === 'room') params.set('q', 'снять');
  appendIfNumber(params, 'pmin', config.priceMin);
  appendIfNumber(params, 'pmax', config.priceMax);
  return `https://m.avito.ru/moskva_i_mo/${pathPart}?${params.toString()}`;
}

function yandexUrl(config, propertyType) {
  const pathPart = propertyType === 'room' ? 'komnata' : 'kvartira';
  const params = new URLSearchParams({ sort: 'DATE_DESC' });
  appendIfNumber(params, 'priceMin', config.priceMin);
  appendIfNumber(params, 'priceMax', config.priceMax);
  if (propertyType === 'flat' && config.rooms.length) params.set('roomsTotal', config.rooms.join(','));
  return `https://realty.yandex.ru/moskva_i_moskovskaya_oblast/snyat/${pathPart}/?${params.toString()}`;
}

function domclickUrl(config, propertyType) {
  const params = new URLSearchParams({
    deal_type: 'rent',
    category: 'living',
    offer_type: propertyType === 'room' ? 'room' : 'flat',
    aids: '2299',
    sort: 'published',
    sort_dir: 'desc',
    offset: '0'
  });
  appendIfNumber(params, 'rent_price__gte', config.priceMin);
  appendIfNumber(params, 'rent_price__lte', config.priceMax);
  appendIfNumber(params, 'total_area__gte', config.totalAreaMin);
  appendIfNumber(params, 'total_area__lte', config.totalAreaMax);
  appendIfNumber(params, 'build_year__gte', config.buildYearMin);
  appendIfNumber(params, 'build_year__lte', config.buildYearMax);
  if (config.metroMode === 'foot' || config.metroMode === 'any') appendIfNumber(params, 'time_on_foot__lte', config.metroMinutesMax);
  if (propertyType === 'flat' && config.rooms.length) params.set('rooms__in', config.rooms.join(','));
  return `https://domclick.ru/search?${params.toString()}`;
}

function buildSearchTargets(configInput) {
  const config = normalizeConfig(configInput);
  if (!config.enabled) return [];
  const builders = {
    avito: avitoUrl,
    cian: cianUrl,
    yandex: yandexUrl,
    domclick: domclickUrl
  };
  return config.sources.flatMap((source) => config.propertyTypes.map((propertyType) => ({
    type: source,
    propertyType,
    label: `${sourceNames[source]} · ${typeNames[propertyType]}`,
    url: builders[source](config, propertyType)
  })));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function digits(value) {
  const match = normalizeText(value).replace(/[^\d]/g, '');
  return match ? Number(match) : null;
}

function extractPrice(text) {
  const match = normalizeText(text).match(/([\d\s]{2,})\s*(?:₽|руб)/i);
  return match ? digits(match[1]) : null;
}

function numberFromMatch(match) {
  return match ? Number(String(match[1]).replace(',', '.')) : null;
}

function extractAreas(text) {
  const normalized = normalizeText(text).replace(/,/g, '.').toLowerCase();
  const totalPatterns = [
    /общ(?:ая|ей)?\s+(?:площадь\s*)?(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i,
    /(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)\s*(?:общ|общая)/i,
    /в\s+(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)\s*(?:квартире|квартира|кв\.)/i,
    /(?:квартира|кв\.)\s+(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i,
    /(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)\s*,?\s*\d+\s*[- ]?\s*(?:к|комн|комнат)/i
  ];
  const roomPatterns = [
    /(?:площадь\s*)?комнат[аы]?\s*(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i,
    /(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)\s*(?:комната|комнаты|в комнате)/i,
    /жилая\s+(?:площадь\s*)?(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i
  ];
  const firstArea = numberFromMatch(normalized.match(/(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i));
  const totalArea = totalPatterns.map((pattern) => numberFromMatch(normalized.match(pattern))).find((value) => value !== null) ?? firstArea;
  const roomArea = roomPatterns.map((pattern) => numberFromMatch(normalized.match(pattern))).find((value) => value !== null);
  return { totalArea, roomArea };
}

function extractRooms(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/(?:студия|studio)\b/.test(normalized)) return 0;
  if (/комнат[ауы]\b/.test(normalized) && !/\d+\s*[- ]?\s*(?:к|комн|комнат)/.test(normalized)) return 1;
  const match = normalized.match(/(\d+)\s*[- ]?\s*(?:к|комн|комнат|комнатная|комнатную|комнатной)/);
  return match ? Number(match[1]) : null;
}

function extractFloor(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/(?:этаж\s*)?(\d{1,2})\s*\/\s*(\d{1,2})|(\d{1,2})\s*этаж\s*из\s*(\d{1,2})/i);
  if (!match) return { floor: null, floorsTotal: null };
  return {
    floor: Number(match[1] || match[3]),
    floorsTotal: Number(match[2] || match[4])
  };
}

function extractBuildYear(text) {
  const match = normalizeText(text).match(/(?:год постройки|построен|дом)\D*(19\d{2}|20\d{2})/i);
  return match ? Number(match[1]) : null;
}

function extractMetro(text) {
  const normalized = normalizeText(text).toLowerCase();
  const match = normalized.match(/(\d{1,2})\s*мин[^\d]{0,20}(пешком|транспорт|на транспорте|метро)/i);
  if (!match) return { minutes: null, mode: null };
  const mode = /пешком/.test(match[2]) ? 'foot' : /транспорт/.test(match[2]) ? 'transport' : 'any';
  return { minutes: Number(match[1]), mode };
}

function extractSellerType(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/(?:собственник|от собственника|без посредник|без комиссии|не агент)/i.test(normalized)) return 'owner';
  if (/(?:агент|агентство|риелтор|риэлтор|посредник|комиссия|комиссию)/i.test(normalized)) return 'agent';
  return null;
}

function extractDeposit(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/(?:без залога|залог 0|депозит 0|без депозита|залог не требуется)/i.test(normalized)) return 'no';
  if (/(?:залог|депозит|обеспечительный платеж|страховой депозит)/i.test(normalized)) return 'yes';
  return null;
}

function inRange(value, min, max, strict) {
  if (min === '' && max === '') return true;
  if (value === null || value === undefined || Number.isNaN(value)) return !strict;
  if (min !== '' && value < min) return false;
  if (max !== '' && value > max) return false;
  return true;
}

function matchesFilters(ad, configInput) {
  return filterDecision(ad, configInput).match;
}

function filterDecision(ad, configInput) {
  const config = normalizeConfig(configInput);
  const text = normalizeText([ad.title, ad.price, ad.location, ad.desc].filter(Boolean).join(' '));
  const price = extractPrice(`${ad.price || ''} ${text}`);
  const areas = extractAreas(text);
  const rooms = extractRooms(text);
  const buildYear = extractBuildYear(text);
  const floorInfo = extractFloor(text);
  const metro = extractMetro(text);
  const sellerType = extractSellerType(text);
  const deposit = extractDeposit(text);
  const missingStrictValue = (value, min, max) => (min !== '' || max !== '') && (value === null || value === undefined || Number.isNaN(value));
  if (missingStrictValue(price, config.priceMin, config.priceMax)) return { match: false, detailsUseful: true, reason: 'нет цены для проверки' };
  if (!inRange(price, config.priceMin, config.priceMax, true)) return { match: false, detailsUseful: false, reason: `цена ${price ?? 'не найдена'} вне диапазона` };
  if (missingStrictValue(areas.totalArea, config.totalAreaMin, config.totalAreaMax)) return { match: false, detailsUseful: true, reason: 'нет общей площади для проверки' };
  if (!inRange(areas.totalArea, config.totalAreaMin, config.totalAreaMax, true)) return { match: false, detailsUseful: false, reason: `общая площадь ${areas.totalArea ?? 'не найдена'} вне диапазона` };
  if (ad.propertyType === 'room' && missingStrictValue(areas.roomArea, config.roomAreaMin, config.roomAreaMax)) return { match: false, detailsUseful: true, reason: 'нет площади комнаты для проверки' };
  if (ad.propertyType === 'room' && !inRange(areas.roomArea, config.roomAreaMin, config.roomAreaMax, true)) return { match: false, detailsUseful: false, reason: `площадь комнаты ${areas.roomArea ?? 'не найдена'} вне диапазона` };
  if (ad.propertyType === 'flat' && config.rooms.length && rooms === null) return { match: false, detailsUseful: true, reason: 'нет количества комнат для проверки' };
  if (ad.propertyType === 'flat' && config.rooms.length && !config.rooms.includes(rooms)) return { match: false, detailsUseful: false, reason: `комнат ${rooms}, выбрано ${config.rooms.join(', ')}` };
  if (!inRange(buildYear, config.buildYearMin, config.buildYearMax, false)) return { match: false, detailsUseful: false, reason: `год ${buildYear ?? 'не найден'} вне диапазона` };
  if (!inRange(floorInfo.floor, config.floorMin, config.floorMax, false)) return { match: false, detailsUseful: false, reason: `этаж ${floorInfo.floor ?? 'не найден'} вне диапазона` };
  if (!inRange(floorInfo.floorsTotal, config.floorsTotalMin, config.floorsTotalMax, false)) return { match: false, detailsUseful: false, reason: `этажность ${floorInfo.floorsTotal ?? 'не найдена'} вне диапазона` };
  if (!inRange(metro.minutes, config.metroMinutesMin, config.metroMinutesMax, false)) return { match: false, detailsUseful: false, reason: `метро ${metro.minutes ?? 'не найдено'} мин вне диапазона` };
  if (config.metroMode !== 'any' && metro.mode && metro.mode !== config.metroMode) return { match: false, detailsUseful: false, reason: `способ до метро ${metro.mode}` };
  if (config.sellerType !== 'any' && sellerType === null) return { match: false, detailsUseful: true, reason: 'нет данных собственник или посредник' };
  if (config.sellerType !== 'any' && sellerType !== config.sellerType) return { match: false, detailsUseful: false, reason: `тип продавца ${sellerType}` };
  if (config.deposit !== 'any' && deposit === null) return { match: false, detailsUseful: true, reason: 'нет данных по залогу' };
  if (config.deposit !== 'any' && deposit !== config.deposit) return { match: false, detailsUseful: false, reason: `залог ${deposit}` };
  return { match: true, detailsUseful: false, reason: 'подходит' };
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  buildSearchTargets,
  matchesFilters,
  filterDecision,
  extractRooms,
  extractAreas,
  extractSellerType,
  extractDeposit
};
