const fs = require('fs');
const path = require('path');

const defaultConfig = {
  enabled: true,
  city: 'Москва',
  query: '',
  sources: ['avito', 'cian', 'yandex', 'domclick'],
  propertyTypes: ['room', 'flat'],
  rooms: [1],
  priceMin: 14000,
  priceMax: 40000,
  areaMin: '',
  areaMax: '',
  metroMinutesMin: '',
  metroMinutesMax: 30,
  metroMode: 'any',
  buildYearMin: 1995,
  buildYearMax: '',
  floorMin: '',
  floorMax: '',
  floorsTotalMin: '',
  floorsTotalMax: '',
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
  config.query = String(config.query || '').trim();
  config.city = String(config.city || defaultConfig.city).trim();
  config.priceMin = toNumber(config.priceMin);
  config.priceMax = toNumber(config.priceMax);
  config.areaMin = toNumber(config.areaMin);
  config.areaMax = toNumber(config.areaMax);
  config.metroMinutesMin = toNumber(config.metroMinutesMin);
  config.metroMinutesMax = toNumber(config.metroMinutesMax);
  config.buildYearMin = toNumber(config.buildYearMin);
  config.buildYearMax = toNumber(config.buildYearMax);
  config.floorMin = toNumber(config.floorMin);
  config.floorMax = toNumber(config.floorMax);
  config.floorsTotalMin = toNumber(config.floorsTotalMin);
  config.floorsTotalMax = toNumber(config.floorsTotalMax);
  config.metroMode = ['any', 'foot', 'transport'].includes(config.metroMode) ? config.metroMode : 'any';
  config.enabled = Boolean(config.enabled);
  config.autostart = Boolean(config.autostart);
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

function roomsText(rooms) {
  if (!rooms.length) return '';
  return rooms.map((room) => `${room}-комнатная`).join(' ');
}

function queryFor(config, propertyType) {
  return [config.query, propertyType === 'room' ? 'комната' : roomsText(config.rooms) || 'квартира']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function cianUrl(config, propertyType) {
  const params = new URLSearchParams({
    currency: '2',
    deal_type: 'rent',
    engine_version: '2',
    offer_type: 'flat',
    region: '1',
    sort: 'creation_date_desc',
    type: '4'
  });
  appendIfNumber(params, 'minprice', config.priceMin);
  appendIfNumber(params, 'maxprice', config.priceMax);
  appendIfNumber(params, 'mintarea', config.areaMin);
  appendIfNumber(params, 'maxtarea', config.areaMax);
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
  const pathPart = propertyType === 'room' ? 'komnaty/sdam/na_dlitelnyy_srok' : 'kvartiry/sdam';
  const params = new URLSearchParams({ s: '104' });
  const q = queryFor(config, propertyType);
  if (q) params.set('q', q);
  appendIfNumber(params, 'pmin', config.priceMin);
  appendIfNumber(params, 'pmax', config.priceMax);
  return `https://www.avito.ru/moskva/${pathPart}?${params.toString()}`;
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
  appendIfNumber(params, 'total_area__gte', config.areaMin);
  appendIfNumber(params, 'total_area__lte', config.areaMax);
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

function extractArea(text) {
  const match = normalizeText(text).replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i);
  return match ? Number(match[1]) : null;
}

function extractRooms(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/комнат[ауы]\b/.test(normalized) && !/\d+\s*[- ]?\s*комн/.test(normalized)) return 1;
  const match = normalized.match(/(\d+)\s*[- ]?\s*(?:к|комн|комнат)/);
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

function inRange(value, min, max, strict) {
  if (min === '' && max === '') return true;
  if (value === null || value === undefined || Number.isNaN(value)) return !strict;
  if (min !== '' && value < min) return false;
  if (max !== '' && value > max) return false;
  return true;
}

function matchesFilters(ad, configInput) {
  const config = normalizeConfig(configInput);
  const text = normalizeText([ad.title, ad.price, ad.location, ad.desc].filter(Boolean).join(' '));
  const price = extractPrice(`${ad.price || ''} ${text}`);
  const area = extractArea(text);
  const rooms = extractRooms(text);
  const buildYear = extractBuildYear(text);
  const floorInfo = extractFloor(text);
  const metro = extractMetro(text);
  if (!inRange(price, config.priceMin, config.priceMax, true)) return false;
  if (!inRange(area, config.areaMin, config.areaMax, true)) return false;
  if (config.rooms.length && rooms !== null && !config.rooms.includes(rooms)) return false;
  if (!inRange(buildYear, config.buildYearMin, config.buildYearMax, false)) return false;
  if (!inRange(floorInfo.floor, config.floorMin, config.floorMax, false)) return false;
  if (!inRange(floorInfo.floorsTotal, config.floorsTotalMin, config.floorsTotalMax, false)) return false;
  if (!inRange(metro.minutes, config.metroMinutesMin, config.metroMinutesMax, false)) return false;
  if (config.metroMode !== 'any' && metro.mode && metro.mode !== config.metroMode) return false;
  if (config.query && !text.toLowerCase().includes(config.query.toLowerCase())) return false;
  return true;
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  buildSearchTargets,
  matchesFilters
};
