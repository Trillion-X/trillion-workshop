// src/tell-devices.mjs
//
// Purpose
//   The one way to tell the person on their own devices for every sender; a sender that adds its own device list repeats
//   it. It is the one list of the places a person is told things on their own devices: a browser's web push subscription, an
//   iPhone's push token, a Mac that reads its notices itself. Every device app registers here the same way
//   (POST /tell/devices) and every sender in src/person-store.mjs reads the rows of its own route. Which routes exist
//   and what address each one takes is DATA (records/tell-the-person.json `devices.routes`).
//
// Non-negotiable invariants
//   1. One registry: a route is a DATA row naming the shape of its address; nothing here names a device, a vendor or
//      an app. A new kind of device is a route row (and, when it is pushed to, a sender wired by name).
//   2. The same address on the same route is one row: registering again on every launch keeps its device_id, and the
//      store is written only when the row is new or its label, app or environment changed, so a launch that changes
//      nothing writes nothing. There is no setup step and no duplicate.
//   3. An address is checked against its shape before it is kept; a malformed one is refused, never stored.
//   4. A device a push service says is gone is removed by its sender (`forget`), so a dead token is never tried twice.
//   5. What leaves the store (`listed`) never carries an address: the person sees their devices by name and route.
//   6. At most `most` rows; the oldest goes first.
//   7. A device says whether its system lets it show notices (`can_show`, one of the DATA `devices.can_show` words)
//      and, when it cannot, where its own switch is (`turn_on`, a link whose scheme the DATA `devices.turn_on_schemes`
//      allows, such as System Settings > Notifications on a Mac). A device that cannot show is listed with both, so
//      the person's Waiting on you (src/waiting-on-you.json `devices`) asks them to turn it on, and the ask leaves by
//      itself when the device next registers as able to show.
//   8. A device may say whether the person is at it now (`present`, one of the DATA `devices.present` words, such as
//      here or away, from the device's own sense: a Mac's time since its last key or click). The newest report is kept
//      with its time (`present_at`) and read by `presence()` as { device, present, at }, where `device` is the route
//      row's own `device`; who is told where reads it (src/tell-the-person.mjs reach_now). An older report means nothing.
//
// Key concepts
//   device  { device_id, route, address, label, app?, environment?, can_show?, turn_on?, present?, present_at?, added_at }
//   route   { id, address: shape name, label }, shapes: web-push-subscription | hex-token | device-id
//
// Security
//   Rows live in this person's own store; an address (a push token or subscription) is only ever handed to its own
//   route's sender. Nothing here reaches another person.
//

import { fromBase64url } from '../../shared-code/src/web-push.mjs';

export class DeviceError extends Error {}

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// The shapes an address can have, by the name a route row gives. Each returns the address as it is kept and the text
// that tells one address from another on its route.
const SHAPES = {
  'web-push-subscription': value => {
    const endpoint = value?.endpoint;
    if (typeof endpoint !== 'string' || !URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:') throw new DeviceError('A web push device needs the https endpoint the browser gave.');
    const { p256dh, auth } = value.keys ?? {};
    if (fromBase64url(p256dh ?? '').length !== 65 || fromBase64url(auth ?? '').length !== 16) throw new DeviceError('A web push device needs the browser\'s p256dh and auth keys.');
    return { address: { endpoint, keys: { p256dh, auth } }, same: endpoint };
  },
  'hex-token': value => {
    if (typeof value !== 'string' || !/^[0-9a-f]{32,400}$/i.test(value.trim())) throw new DeviceError('This device\'s token is the hex text the system gave it.');
    return { address: value.trim().toLowerCase(), same: value.trim().toLowerCase() };
  },
  'device-id': value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{8,80}$/.test(value.trim())) throw new DeviceError('This device\'s address is the id it keeps for itself.');
    return { address: value.trim(), same: value.trim() };
  },
};

/**
 * store:  { read() → [device], write([device]) }
 * routes: records/tell-the-person.json devices.routes
 */
export function tellDevices(store, { routes, now = () => new Date(), most = 40, can_show = [], turn_on_schemes = [], present: presentWords = [] } = {}) {
  const routeRows = new Map(routes.map(row => [row.id, row]));
  for (const row of routes) if (!SHAPES[row.address]) throw new DeviceError(`The route ${row.id} names an address shape nothing reads: ${row.address}.`);
  const list = () => (Array.isArray(store.read()) ? store.read() : []);
  const sameOf = device => SHAPES[routeRows.get(device.route)?.address]?.(device.address).same;
  const addressOf = (route, address) => {
    const row = routeRows.get(route);
    if (!row) throw new DeviceError(`There is no device route called ${route}. Routes: ${routes.map(item => item.id).join(', ')}.`);
    return SHAPES[row.address](address);
  };
  const listed = () => list().map(({ device_id, route, label, app, environment, can_show: shows, turn_on, present, present_at, added_at }) => ({
    device_id, route, label, ...(app ? { app } : {}), ...(environment ? { environment } : {}),
    ...(shows ? { can_show: shows } : {}), ...(turn_on ? { turn_on } : {}), ...(present ? { present, present_at } : {}), added_at,
  }));
  const presentWord = value => (nonempty(value) && presentWords.includes(value.trim()) ? value.trim() : null);
  const showsWord = value => (nonempty(value) && can_show.includes(value.trim()) ? value.trim() : null);
  const turnOnLink = value => {
    if (!nonempty(value) || !URL.canParse(value.trim())) return null;
    return turn_on_schemes.includes(new URL(value.trim()).protocol.replace(/:$/, '')) ? value.trim().slice(0, 400) : null;
  };
  return {
    /** Every device on `route`, with its address, for that route's sender; every device when no route is named. */
    of: route => list().filter(device => !route || device.route === route),
    listed,
    /** Looks up one validated route/address pair without writing or returning its private address. */
    find({ route, address } = {}) {
      const shaped = addressOf(route, address);
      const device = list().find(item => item.route === route && sameOf(item) === shaped.same);
      return device ? { found: true, device_id: device.device_id, registration_matches: JSON.stringify(addressOf(route, device.address).address) === JSON.stringify(shaped.address) } : { found: false, registration_matches: false };
    },
    add({ route, address, label = '', app = null, environment = null, can_show: shows = null, turn_on = null, present = null } = {}) {
      const shaped = addressOf(route, address);
      const earlier = list().find(device => device.route === route && sameOf(device) === shaped.same);
      const device = {
        device_id: earlier?.device_id ?? crypto.randomUUID(), route, address: shaped.address,
        label: nonempty(label) ? label.trim().slice(0, 120) : routeRows.get(route).label,
        ...(nonempty(app) ? { app: app.trim().slice(0, 200) } : {}),
        ...(nonempty(environment) ? { environment: environment.trim().slice(0, 40) } : {}),
        ...(showsWord(shows) ? { can_show: showsWord(shows) } : {}),
        ...(turnOnLink(turn_on) ? { turn_on: turnOnLink(turn_on) } : {}),
        // A device that says nothing about presence keeps what it last said.
        ...(presentWord(present) ? { present: presentWord(present), present_at: now().toISOString() }
          : earlier?.present ? { present: earlier.present, present_at: earlier.present_at } : {}),
        added_at: earlier?.added_at ?? now().toISOString(),
      };
      if (JSON.stringify(earlier) === JSON.stringify(device)) return { device_id: device.device_id, devices: listed() };
      const kept = [...list().filter(item => item.device_id !== device.device_id), device]
        .sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at)).slice(-most);
      store.write(kept);
      return { device_id: device.device_id, devices: listed() };
    },
    remove({ device_id } = {}) {
      if (!nonempty(device_id)) throw new DeviceError('Name the device to remove by its device_id.');
      store.write(list().filter(device => device.device_id !== device_id));
      return { removed: true, devices: listed() };
    },
    /** Whether the person is at each device that said so (invariant 8): [{ device, present, at }]. */
    presence: () => list().filter(device => device.present).map(device => ({ device: routeRows.get(device.route)?.device ?? null, present: device.present, at: device.present_at })),
    /** A sender's push service said this device is gone. */
    forget(device_id) {
      store.write(list().filter(device => device.device_id !== device_id));
    },
  };
}
