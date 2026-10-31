// tools/get-there/test/get-there.test.mjs
//
// Route buttons and the nearest places, with a stand-in for the network. Every place, street and brand here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findNearestPlaces, kmBetween, placesFrom, readSettings, routeButtons, stopWords } from '../read-data/get-there.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const settings = readSettings();

test('route buttons open each maps app with the start and the stop on the way', () => {
  const { buttons } = routeButtons({ origin: 'Sampleton, ST', destination: { lat: 34, lon: -118.39 }, stops: ['Loaf Mart, Breadville'] });
  assert.deepEqual(buttons.map(button => button.id), ['apple-maps', 'google-maps']);
  assert.equal(buttons[0].url, 'https://maps.apple.com/directions?source=Sampleton%2C%20ST&destination=34%2C-118.39&waypoint=Loaf%20Mart%2C%20Breadville&mode=driving');
  assert.equal(buttons[1].url, 'https://www.google.com/maps/dir/?api=1&origin=Sampleton%2C%20ST&destination=34%2C-118.39&waypoints=Loaf%20Mart%2C%20Breadville&travelmode=driving');
  assert.match(routeButtons({ destination: 'Loaf Mart', mode: 'cycle' }).buttons[1].url, /travelmode=bicycling/);
  assert.equal(routeButtons({}).buttons.length, 0);
  assert.equal(routeButtons({}).said, settings.words.no_destination);
});

test('a stop is words, a point or an address object', () => {
  assert.equal(stopWords('  Loaf Mart '), 'Loaf Mart');
  assert.equal(stopWords({ latitude: 1.5, longitude: 2 }), '1.5,2');
  assert.equal(stopWords({ address: '3 Sample Lane' }), '3 Sample Lane');
  assert.equal(stopWords(null), '');
});

const start = { lat: 33.995, lon: -118.467 };
const elements = [
  { type: 'node', id: 2, lat: 34.0628, lon: -118.4437, tags: { brand: 'Loaf Mart', name: 'Loaf Mart', 'addr:housenumber': '10', 'addr:street': 'Weyburn Avenue' } },
  { type: 'way', id: 1, center: { lat: 33.9991, lon: -118.3939 }, tags: { brand: 'Loaf Mart', 'addr:housenumber': '20', 'addr:street': 'Jefferson Boulevard', 'addr:city': 'Breadville' } },
  { type: 'node', id: 3, lat: 33.99912, lon: -118.39391, tags: { brand: 'Loaf Mart' } },
];

test('nearest places are sorted by distance, deduplicated by spot, and each has its route', () => {
  const places = placesFrom(elements, start, { name: 'Loaf Mart', most: 5 });
  assert.equal(places.length, 2);
  assert.equal(places[0].address, '20 Jefferson Boulevard, Breadville');
  assert.ok(places[0].km < places[1].km);
  assert.match(places[0].buttons[0].url, /destination=Loaf%20Mart%2C%2020%20Jefferson/);
  assert.ok(Math.abs(kmBetween(start, { lat: 33.9991, lon: -118.3939 }) - 6.7) < 0.2);
  assert.equal(placesFrom(elements, start, { name: 'Loaf Mart', most: 1 }).length, 1);
});

test('a busy copy of the places service hands the read to the next, and a geocoded start is looked up once', async () => {
  const asked = [];
  const fetchFor = async (url, options) => {
    asked.push(String(url));
    if (String(url).includes('nominatim') && !options?.method) return { ok: true, json: async () => [{ lat: '33.995', lon: '-118.467' }] };
    return asked.filter(address => !address.includes('nominatim')).length === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => ({ elements }) };
  };
  const answer = await findNearestPlaces({ name: 'Loaf Mart', near: 'Sampleton, ST', most: 2 }, { fetch: fetchFor });
  assert.equal(answer.places.length, 2);
  assert.equal(asked.filter(address => address.includes('nominatim')).length, 1);
  assert.equal(asked.filter(address => !address.includes('nominatim')).length, 2);
  assert.match(answer.said, /^2 Loaf Mart near Sampleton, ST; the nearest is 20 Jefferson Boulevard, Breadville, /);
});

test('every copy busy: the address service\'s search around the start answers instead; none found says so', async () => {
  const searched = await findNearestPlaces({ name: 'Loaf Mart', near: start }, { fetch: async url => (String(url).includes('nominatim') ? { ok: true, json: async () => [
    { osm_type: 'way', osm_id: 9, name: 'Loaf Mart', lat: '33.9991', lon: '-118.3939', address: { house_number: '20', road: 'Jefferson Boulevard', city: 'Breadville' } },
    { osm_type: 'node', osm_id: 8, name: 'Loaf Mart Optical', lat: '33.99', lon: '-118.39', address: {} },
  ] } : { ok: false, status: 504 }) });
  assert.deepEqual(searched.places.map(place => place.address), ['20 Jefferson Boulevard, Breadville']);
  const none = await findNearestPlaces({ name: 'Loaf Mart', near: start }, { fetch: async () => ({ ok: true, json: async () => ({ elements: [] }) }) });
  assert.deepEqual(none.places, []);
  assert.match(none.said, /^No Loaf Mart within 25 km of /);
  const unknown = await findNearestPlaces({ name: 'Loaf Mart', near: 'Nowhere' }, { fetch: async () => ({ ok: true, json: async () => [] }) });
  assert.match(unknown.said, /Could not find where Nowhere is/);
  await assert.rejects(findNearestPlaces({ name: 'Loaf Mart', near: start }, { fetch: async () => { throw new Error('offline'); } }), /did not answer \(offline\)/);
});

test('what a caller may ask is bounded by the settings', async () => {
  let query = '';
  await findNearestPlaces({ name: 'Loaf Mart', near: start, radius_km: 9999, most: 999 }, { fetch: async (url, options) => { query = decodeURIComponent(options.body); return { ok: true, json: async () => ({ elements: [] }) }; } });
  assert.match(query, new RegExp(`around:${settings.radius_km_at_most * 1000},`));
  assert.match(query, new RegExp(`out center tags ${settings.most_at_most * 4};`));
});

test('the rows pack what the tools read and the pure one runs its own sample', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:route-buttons', 'tool:find-nearest-places']);
  for (const row of rows) assert.deepEqual(row.invoke.files.package_files.paths, ['do-work', 'read-data']);
  assert.equal(rows[0].invoke.internet, false);
  assert.equal(rows[1].invoke.internet, true);
  const sample = rows[0].verify[0];
  assert.match(routeButtons(sample.input).buttons[0].url, new RegExp(sample.contains.replace('.', '\\.')));
});
