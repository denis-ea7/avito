const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = process.env.SENT_LISTINGS_FILE || path.join(__dirname, '..', 'sent-listings.json');
const MAX_ITEMS = 10000;

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePriceValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeSentListing(item = {}) {
  return {
    id: compactText(item.id),
    href: compactText(item.href),
    routeUrl: compactText(item.routeUrl),
    title: compactText(item.title),
    label: compactText(item.label),
    source: compactText(item.source),
    propertyType: compactText(item.propertyType),
    region: compactText(item.region),
    priceText: compactText(item.priceText),
    priceValue: normalizePriceValue(item.priceValue),
    publishedAtText: compactText(item.publishedAtText),
    sentAt: compactText(item.sentAt) || new Date().toISOString()
  };
}

function readSentListings(filePath = DEFAULT_FILE) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSentListing)
      .filter((item) => item.id && item.href);
  } catch (_) {
    return [];
  }
}

function writeSentListings(filePath, items) {
  const next = items
    .map(normalizeSentListing)
    .filter((item) => item.id && item.href)
    .slice(-MAX_ITEMS);
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tempFile, filePath);
  return next;
}

function saveSentListing(item, filePath = DEFAULT_FILE) {
  const listing = normalizeSentListing(item);
  if (!listing.id || !listing.href) return null;
  const items = readSentListings(filePath);
  const index = items.findIndex((entry) => entry.id === listing.id);
  if (index >= 0) {
    items[index] = listing;
  } else {
    items.push(listing);
  }
  writeSentListings(filePath, items);
  return listing;
}

module.exports = {
  DEFAULT_FILE,
  readSentListings,
  writeSentListings,
  saveSentListing
};
