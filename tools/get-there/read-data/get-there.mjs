// tools/get-there/read-data/get-there.mjs
//
// Gets a person somewhere with nothing to look up: route buttons that open a trip in their maps apps
// (tool:route-buttons), and the nearest places of a brand or a name around a start, each with its own route buttons
// (tool:find-nearest-places).
//
// Invariants
//   1. Blind: maps apps, travel modes, place services and words are DATA (get-there.json); nothing here names a brand,
//      a store or an app.
//   2. Route buttons are pure: same input, same addresses, no network.
//   3. Places are read only from the services the DATA names, with the identifying user agent they ask for; a service
//      that does not answer is said in words, never guessed around.
//
// Key concepts
//   stop   an address or place name as words, or { lat, lon } (also { latitude, longitude }), or { address }
//   button { id, label, url }
import { readFileSync } from 'node:fs';

export const readSettings = () => JSON.parse(readFileSync(new URL('./get-there.json', import.meta.url), 'utf8'));
const settings = readSettings();

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const pointOf = stop => {
  const lat = Number(stop?.lat ?? stop?.latitude); const lon = Number(stop?.lon ?? stop?.lng ?? stop?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
};
/** One stop as maps apps read it: "lat,lon" for a point, else its words. */
export const stopWords = stop => {
  if (typeof stop === 'string') return stop.trim();
  const point = pointOf(stop);
  if (point) return `${point.lat},${point.lon}`;
  return String(stop?.address ?? stop?.name ?? '').trim();
};

/** input { destination, origin?, stops?: [stop], mode?: drive | walk | transit | cycle } → { buttons, said? } */
export function routeButtons(input, data = settings) {
  const destination = stopWords(input?.destination);
  if (!destination) return { buttons: [], said: data.words.no_destination };
  const origin = input?.origin ? stopWords(input.origin) : '';
  const stops = (Array.isArray(input?.stops) ? input.stops : []).map(stopWords).filter(Boolean);
  const mode = input?.mode ?? data.default_mode;
  const buttons = data.maps.map(app => {
    const enc = encodeURIComponent;
    const waypoints = app.waypoints
      ? (stops.length ? fill(app.waypoints, { stops: stops.map(enc).join(enc(app.stop_joiner ?? '|')) }) : '')
      : stops.map(stop => fill(app.waypoint, { stop: enc(stop) })).join('');
    const url = fill(app.route, {
      source: origin ? fill(app.source, { origin: enc(origin) }) : '',
      destination: enc(destination), waypoints, mode: app.modes?.[mode] ?? app.modes?.[data.default_mode] ?? mode,
    });
    return { id: app.id, label: app.label, url };
  });
  return { buttons };
}

const RADIUS = 6371;
/** Great-circle distance in km between two points. */
export function kmBetween(a, b) {
  const rad = degrees => degrees * Math.PI / 180;
  const dLat = rad(b.lat - a.lat); const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The OpenStreetMap elements a near query answered, as places sorted nearest first, with route buttons from start (to
 *  the place's name and address when it has one, so the maps app shows the place, else to its point). */
export function placesFrom(elements, start, { name, most, mode }, data = settings) {
  const seen = new Set();
  return (elements ?? []).map(element => {
    const point = pointOf(element) ?? pointOf(element.center);
    if (!point) return null;
    const tags = element.tags ?? {};
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const address = [street, tags['addr:city'], tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(', ');
    return { name: tags.name ?? tags.brand ?? name, address: address || null, lat: point.lat, lon: point.lon, km: Math.round(kmBetween(start, point) * 10) / 10, opening_hours: tags.opening_hours ?? null, id: `${element.type}/${element.id}` };
  }).filter(Boolean)
    .filter(place => { const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.km - b.km).slice(0, most)
    .map(place => ({ ...place, ...routeButtons({ origin: start, destination: place.address ? `${place.name}, ${place.address}` : { lat: place.lat, lon: place.lon }, mode }, data) }));
}

const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

/**
 * input  { name, near: stop, radius_km?, most?, mode? }
 * fetch  the network call (the run's own, or a test's)
 * → { places: [{ name, address, lat, lon, km, opening_hours, buttons }], start, said }
 */
export async function findNearestPlaces(input, { fetch: send = globalThis.fetch, data = settings } = {}) {
  const name = String(input?.name ?? '').trim();
  if (!name) return { places: [], said: data.words.no_destination };
  const most = Math.max(1, Math.min(Number(input?.most) || data.most, data.most_at_most));
  const km = Math.min(Number(input?.radius_km) || data.radius_km, data.radius_km_at_most);
  const headers = { 'user-agent': data.places.user_agent, accept: 'application/json' };
  const signal = () => AbortSignal.timeout(data.places.timeout_ms);
  let start = pointOf(input?.near);
  const startWords = stopWords(input?.near);
  if (!start) {
    const found = await send(fill(data.places.geocode, { query: encodeURIComponent(startWords) }), { headers, signal: signal() });
    if (!found.ok) throw new Error(`the address service answered ${found.status}`);
    const [first] = await found.json();
    start = pointOf(first);
    if (!start) return { places: [], said: fill(data.words.start_unknown, { start: startWords }) };
  }
  const near = async template => {
    const query = fill(template, { name: escapeRegex(name), radius_m: Math.round(km * 1000), lat: start.lat, lon: start.lon, most_raw: most * 4 });
    // Several copies of the same service are asked in turn: one that is busy or slow hands the read to the next.
    let last = null;
    for (const address of [].concat(data.places.near)) {
      try {
        const answer = await send(address, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: signal() });
        if (!answer.ok) { last = `the places service answered ${answer.status}`; continue; }
        return placesFrom((await answer.json()).elements, start, { name, most, mode: input?.mode }, data);
      } catch (error) { last = `the places service did not answer (${error.message})`; }
    }
    // Every copy busy: the address service's own search inside a box around the start, its results read as places.
    if (data.places.near_by_search) {
      const dLat = km / 111; const dLon = km / (111 * Math.max(0.1, Math.cos(start.lat * Math.PI / 180)));
      const box = { west: start.lon - dLon, east: start.lon + dLon, north: start.lat + dLat, south: start.lat - dLat };
      const answer = await send(fill(data.places.near_by_search, { name: encodeURIComponent(name), ...box }), { headers, signal: signal() }).catch(() => null);
      if (answer?.ok) {
        const named = (await answer.json()).filter(row => String(row.name ?? '').toLowerCase() === name.toLowerCase());
        return placesFrom(named.map(row => ({ type: row.osm_type, id: row.osm_id, lat: row.lat, lon: row.lon, tags: {
          name: row.name, 'addr:housenumber': row.address?.house_number, 'addr:street': row.address?.road,
          'addr:city': row.address?.city ?? row.address?.town ?? row.address?.village, 'addr:state': row.address?.state, 'addr:postcode': row.address?.postcode,
        } })), start, { name, most, mode: input?.mode }, data);
      }
    }
    throw new Error(last ?? 'no places service is named');
  };
  let places = await near(data.places.near_query);
  if (!places.length && data.places.near_query_by_name) places = await near(data.places.near_query_by_name);
  const said = places.length
    ? fill(data.words.found, { count: places.length, name, start: startWords || `${start.lat},${start.lon}`, nearest: places[0].address ?? places[0].name, km: places[0].km })
    : fill(data.words.none, { name, km, start: startWords || `${start.lat},${start.lon}` });
  return { places, start, said };
}
