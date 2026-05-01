const fs = require('fs');
const path = require('path');

const defaultConfig = {
  enabled: true,
  sources: ['avito', 'cian', 'yandex', 'domclick'],
  propertyTypes: ['room', 'flat'],
  rooms: [1],
  priceMin: 14000,
  priceMax: 40000,
  flatRooms: [1],
  roomFlatRooms: [],
  flatPriceMin: 14000,
  flatPriceMax: 40000,
  roomPriceMin: 14000,
  roomPriceMax: 40000,
  totalAreaMin: '',
  totalAreaMax: '',
  roomAreaMin: '',
  roomAreaMax: '',
  metroMinutesMin: '',
  metroMinutesMax: 30,
  metroMode: 'any',
  centerTransitMinutesMax: '',
  mkadDistanceMax: '',
  buildYearMin: 1995,
  buildYearMax: '',
  floorMin: '',
  floorMax: '',
  floorsTotalMin: '',
  floorsTotalMax: '',
  sellerType: 'any',
  deposit: 'any',
  roomOwnerOnly: false,
  roomNoDepositOnly: false,
  aiEnabled: false,
  aiProvider: 'deepseek',
  aiModel: 'deepseek-chat',
  deepseekApiKey: '',
  autostart: true,
  proxyMode: 'off',
  proxyList: ''
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

const searchRegions = {
  moscow: 'Москва',
  area: 'Москва+МО'
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
  config.flatRooms = toNumberArray(input.flatRooms !== undefined ? input.flatRooms : input.rooms !== undefined ? input.rooms : defaultConfig.flatRooms);
  config.roomFlatRooms = toNumberArray(input.roomFlatRooms !== undefined ? input.roomFlatRooms : defaultConfig.roomFlatRooms);
  config.rooms = config.flatRooms;
  config.priceMin = toNumber(config.priceMin);
  config.priceMax = toNumber(config.priceMax);
  config.flatPriceMin = toNumber(input.flatPriceMin !== undefined ? input.flatPriceMin : input.priceMin !== undefined ? input.priceMin : defaultConfig.flatPriceMin);
  config.flatPriceMax = toNumber(input.flatPriceMax !== undefined ? input.flatPriceMax : input.priceMax !== undefined ? input.priceMax : defaultConfig.flatPriceMax);
  config.roomPriceMin = toNumber(input.roomPriceMin !== undefined ? input.roomPriceMin : input.priceMin !== undefined ? input.priceMin : defaultConfig.roomPriceMin);
  config.roomPriceMax = toNumber(input.roomPriceMax !== undefined ? input.roomPriceMax : input.priceMax !== undefined ? input.priceMax : defaultConfig.roomPriceMax);
  config.totalAreaMin = toNumber(config.totalAreaMin !== undefined ? config.totalAreaMin : config.areaMin);
  config.totalAreaMax = toNumber(config.totalAreaMax !== undefined ? config.totalAreaMax : config.areaMax);
  config.roomAreaMin = toNumber(config.roomAreaMin);
  config.roomAreaMax = toNumber(config.roomAreaMax);
  if (config.roomAreaMin !== '' && config.roomAreaMin <= 1) config.roomAreaMin = '';
  config.metroMinutesMin = toNumber(config.metroMinutesMin);
  config.metroMinutesMax = toNumber(config.metroMinutesMax);
  config.centerTransitMinutesMax = toNumber(config.centerTransitMinutesMax);
  config.mkadDistanceMax = toNumber(config.mkadDistanceMax);
  config.buildYearMin = toNumber(config.buildYearMin);
  config.buildYearMax = toNumber(config.buildYearMax);
  config.floorMin = toNumber(config.floorMin);
  config.floorMax = toNumber(config.floorMax);
  config.floorsTotalMin = toNumber(config.floorsTotalMin);
  config.floorsTotalMax = toNumber(config.floorsTotalMax);
  config.metroMode = ['any', 'foot', 'transport'].includes(config.metroMode) ? config.metroMode : 'any';
  config.sellerType = ['any', 'owner', 'agent'].includes(config.sellerType) ? config.sellerType : 'any';
  config.deposit = ['any', 'yes', 'no'].includes(config.deposit) ? config.deposit : 'any';
  config.roomOwnerOnly = Boolean(config.roomOwnerOnly);
  config.roomNoDepositOnly = Boolean(config.roomNoDepositOnly);
  config.aiEnabled = Boolean(config.aiEnabled);
  config.aiProvider = 'deepseek';
  config.aiModel = String(config.aiModel || defaultConfig.aiModel).trim() || defaultConfig.aiModel;
  config.deepseekApiKey = String(config.deepseekApiKey || '').trim();
  config.proxyMode = ['off', 'on', 'alternate'].includes(config.proxyMode) ? config.proxyMode : 'off';
  config.proxyList = String(config.proxyList || '').trim();
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

function priceBounds(config, propertyType) {
  return propertyType === 'room'
    ? { min: config.roomPriceMin, max: config.roomPriceMax }
    : { min: config.flatPriceMin, max: config.flatPriceMax };
}

function cianUrl(config, propertyType, region) {
  const price = priceBounds(config, propertyType);
  const params = new URLSearchParams({
    currency: '2',
    deal_type: 'rent',
    engine_version: '2',
    offer_type: 'flat',
    sort: 'creation_date_desc',
    type: '4'
  });
  params.set('region', region === 'moscow' ? '1' : '4593');
  appendIfNumber(params, 'minprice', price.min);
  appendIfNumber(params, 'maxprice', price.max);
  appendIfNumber(params, 'mintarea', config.totalAreaMin);
  appendIfNumber(params, 'maxtarea', config.totalAreaMax);
  appendIfNumber(params, 'minfloor', config.floorMin);
  appendIfNumber(params, 'maxfloor', config.floorMax);
  appendIfNumber(params, 'min_house_year', config.buildYearMin);
  appendIfNumber(params, 'max_house_year', config.buildYearMax);
  if (propertyType === 'room') params.set('room0', '1');
  if (propertyType === 'flat' && config.flatRooms.length) {
    config.flatRooms.forEach((room) => params.set(`room${room}`, '1'));
  }
  return `https://www.cian.ru/cat.php?${params.toString()}`;
}

function avitoUrl(config, propertyType, region) {
  const price = priceBounds(config, propertyType);
  const pathPart = propertyType === 'room' ? 'komnaty/sdam/na_dlitelnyy_srok-ASgBAgICAkSQA74QqAn2YA' : 'kvartiry/sdam-ASgBAgICAUSSA8gQ';
  const regionPath = region === 'moscow' ? 'moskva' : 'moskva_i_mo';
  const params = new URLSearchParams({ localPriority: '0', s: '104' });
  if (propertyType === 'flat') params.set('f', 'ASgBAgICAkSSA8gQiqcVtp2SAw');
  appendIfNumber(params, 'pmin', price.min);
  appendIfNumber(params, 'pmax', price.max);
  return `https://m.avito.ru/${regionPath}/${pathPart}?${params.toString()}`;
}

function yandexUrl(config, propertyType, region) {
  const price = priceBounds(config, propertyType);
  const pathPart = propertyType === 'room' ? 'komnata' : 'kvartira';
  const regionPath = region === 'moscow' ? 'moskva' : 'moskva_i_moskovskaya_oblast';
  const params = new URLSearchParams({ sort: 'DATE_DESC' });
  appendIfNumber(params, 'priceMin', price.min);
  appendIfNumber(params, 'priceMax', price.max);
  if (propertyType === 'flat' && config.flatRooms.length) params.set('roomsTotal', config.flatRooms.join(','));
  return `https://realty.yandex.ru/${regionPath}/snyat/${pathPart}/?${params.toString()}`;
}

function domclickUrl(config, propertyType) {
  const price = priceBounds(config, propertyType);
  const params = new URLSearchParams({
    deal_type: 'rent',
    category: 'living',
    offer_type: propertyType === 'room' ? 'room' : 'flat',
    aids: '2299',
    sort: 'published',
    sort_dir: 'desc',
    offset: '0'
  });
  appendIfNumber(params, 'rent_price__gte', price.min);
  appendIfNumber(params, 'rent_price__lte', price.max);
  appendIfNumber(params, 'total_area__gte', config.totalAreaMin);
  appendIfNumber(params, 'total_area__lte', config.totalAreaMax);
  appendIfNumber(params, 'build_year__gte', config.buildYearMin);
  appendIfNumber(params, 'build_year__lte', config.buildYearMax);
  if (config.metroMode === 'foot' || config.metroMode === 'any') appendIfNumber(params, 'time_on_foot__lte', config.metroMinutesMax);
  if (propertyType === 'flat' && config.flatRooms.length) params.set('rooms__in', config.flatRooms.join(','));
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
  return config.sources.flatMap((source) => {
    const regions = source === 'domclick' ? ['area'] : ['moscow', 'area'];
    return regions.flatMap((region) => config.propertyTypes.map((propertyType) => ({
      type: source,
      propertyType,
      region,
      label: `${sourceNames[source]} · ${searchRegions[region]} · ${typeNames[propertyType]}`,
      url: builders[source](config, propertyType, region)
    })));
  });
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
  const areaUnit = '(?:м²|м2|кв\\.?\\s*м|[mм](?![a-zа-яё]))';
  const totalPatterns = [
    new RegExp(`общ(?:ая|ей)?\\s+(?:площадь\\s*)?(\\d+(?:\\.\\d+)?)\\s*${areaUnit}`, 'i'),
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${areaUnit}\\s*(?:общ|общая)`, 'i'),
    new RegExp(`в\\s+(\\d+(?:\\.\\d+)?)\\s*${areaUnit}\\s*(?:квартире|квартира|кв\\.)`, 'i'),
    new RegExp(`(?:квартира|кв\\.)\\s+(\\d+(?:\\.\\d+)?)\\s*${areaUnit}`, 'i'),
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${areaUnit}\\s*,?\\s*\\d+\\s*[- ]?\\s*(?:к|комн|комнат)`, 'i')
  ];
  const roomPatterns = [
    new RegExp(`(?:площадь\\s*)?комнат[аы]?\\s*(\\d+(?:\\.\\d+)?)\\s*${areaUnit}`, 'i'),
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${areaUnit}\\s*(?:комната|комнаты|в комнате)`, 'i'),
    new RegExp(`жилая\\s+(?:площадь\\s*)?(\\d+(?:\\.\\d+)?)\\s*${areaUnit}`, 'i')
  ];
  const firstArea = numberFromMatch(normalized.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${areaUnit}`, 'i')));
  const totalArea = totalPatterns.map((pattern) => numberFromMatch(normalized.match(pattern))).find((value) => value !== null) ?? firstArea;
  const roomArea = roomPatterns.map((pattern) => numberFromMatch(normalized.match(pattern))).find((value) => value !== null) ?? (
    /(?:комната|komnata|koyko-mesto)/i.test(normalized) ? firstArea : undefined
  );
  return { totalArea, roomArea };
}

function extractRooms(text, propertyType = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (/(?:студия|studio)\b/.test(normalized)) return 0;
  const wordRooms = normalized.match(/(?:в\s+)?(одно|однокомнатн|двух|двухкомнатн|трех|трёх|трехкомнатн|трёхкомнатн|четырех|четырёх|четырехкомнатн|четырёхкомнатн|пяти|пятикомнатн)[-\s]*(?:комнатн|комн)/);
  if (wordRooms) {
    const value = wordRooms[1];
    if (/одно|однокомнатн/.test(value)) return 1;
    if (/двух/.test(value)) return 2;
    if (/трех|трёх/.test(value)) return 3;
    if (/четырех|четырёх/.test(value)) return 4;
    if (/пяти/.test(value)) return 5;
  }
  if (propertyType !== 'room' && /комнат[ауы]\b/.test(normalized) && !/\d+\s*[- ]?\s*(?:к|комн|комнат)/.test(normalized)) return 1;
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
  const priceRange = priceBounds(config, ad.propertyType);
  const price = extractPrice(`${ad.price || ''} ${text}`);
  const areas = extractAreas(text);
  const rooms = extractRooms(text, ad.propertyType);
  const buildYear = extractBuildYear(text);
  const floorInfo = extractFloor(text);
  const metro = extractMetro(text);
  const sellerType = extractSellerType(text);
  const deposit = extractDeposit(text);
  const sellerFilter = ad.propertyType === 'room' && config.roomOwnerOnly ? 'owner' : config.sellerType;
  const depositFilter = ad.propertyType === 'room' && config.roomNoDepositOnly ? 'no' : config.deposit;
  const missingStrictValue = (value, min, max) => (min !== '' || max !== '') && (value === null || value === undefined || Number.isNaN(value));
  let detailsUseful = false;
  if (missingStrictValue(price, priceRange.min, priceRange.max)) detailsUseful = true;
  if (price !== null && price !== undefined && !Number.isNaN(price) && !inRange(price, priceRange.min, priceRange.max, true)) return { match: false, detailsUseful: false, reason: `цена ${price} вне диапазона` };
  if (missingStrictValue(areas.totalArea, config.totalAreaMin, config.totalAreaMax)) detailsUseful = true;
  if (!missingStrictValue(areas.totalArea, config.totalAreaMin, config.totalAreaMax) && !inRange(areas.totalArea, config.totalAreaMin, config.totalAreaMax, true)) return { match: false, detailsUseful: false, reason: `общая площадь ${areas.totalArea} вне диапазона` };
  if (ad.propertyType === 'room' && missingStrictValue(areas.roomArea, config.roomAreaMin, config.roomAreaMax)) detailsUseful = true;
  if (ad.propertyType === 'room' && !missingStrictValue(areas.roomArea, config.roomAreaMin, config.roomAreaMax) && !inRange(areas.roomArea, config.roomAreaMin, config.roomAreaMax, true)) return { match: false, detailsUseful: false, reason: `площадь комнаты ${areas.roomArea} вне диапазона` };
  if (ad.propertyType === 'flat' && config.flatRooms.length && rooms === null) detailsUseful = true;
  if (ad.propertyType === 'flat' && config.flatRooms.length && rooms !== null && !config.flatRooms.includes(rooms)) return { match: false, detailsUseful: false, reason: `комнат ${rooms}, выбрано ${config.flatRooms.join(', ')}` };
  if (ad.propertyType === 'room' && config.roomFlatRooms.length && rooms === null) detailsUseful = true;
  if (ad.propertyType === 'room' && config.roomFlatRooms.length && rooms !== null && !config.roomFlatRooms.includes(rooms)) return { match: false, detailsUseful: false, reason: `комнат в квартире ${rooms}, выбрано ${config.roomFlatRooms.join(', ')}` };
  if (missingStrictValue(buildYear, config.buildYearMin, config.buildYearMax)) detailsUseful = true;
  if (missingStrictValue(floorInfo.floor, config.floorMin, config.floorMax)) detailsUseful = true;
  if (missingStrictValue(floorInfo.floorsTotal, config.floorsTotalMin, config.floorsTotalMax)) detailsUseful = true;
  if (missingStrictValue(metro.minutes, config.metroMinutesMin, config.metroMinutesMax)) detailsUseful = true;
  if (!inRange(buildYear, config.buildYearMin, config.buildYearMax, false)) return { match: false, detailsUseful: false, reason: `год ${buildYear ?? 'не найден'} вне диапазона` };
  if (!inRange(floorInfo.floor, config.floorMin, config.floorMax, false)) return { match: false, detailsUseful: false, reason: `этаж ${floorInfo.floor ?? 'не найден'} вне диапазона` };
  if (!inRange(floorInfo.floorsTotal, config.floorsTotalMin, config.floorsTotalMax, false)) return { match: false, detailsUseful: false, reason: `этажность ${floorInfo.floorsTotal ?? 'не найдена'} вне диапазона` };
  if (!inRange(metro.minutes, config.metroMinutesMin, config.metroMinutesMax, false)) return { match: false, detailsUseful: false, reason: `метро ${metro.minutes ?? 'не найдено'} мин вне диапазона` };
  if (config.metroMode !== 'any' && !metro.mode) detailsUseful = true;
  if (config.metroMode !== 'any' && metro.mode && metro.mode !== 'any' && metro.mode !== config.metroMode) return { match: false, detailsUseful: false, reason: `способ до метро ${metro.mode}` };
  if (sellerFilter !== 'any' && sellerType === null) detailsUseful = true;
  if (sellerFilter !== 'any' && sellerType !== null && sellerType !== sellerFilter) return { match: false, detailsUseful: false, reason: `тип продавца ${sellerType}` };
  if (depositFilter !== 'any' && deposit === null) detailsUseful = true;
  if (depositFilter !== 'any' && deposit !== null && deposit !== depositFilter) return { match: false, detailsUseful: false, reason: `залог ${deposit}` };
  return { match: true, detailsUseful, reason: 'подходит' };
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
