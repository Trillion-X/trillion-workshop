// src/devices.mjs
//
// Purpose: the one composer of the Trillion apps a person can put on their devices (DATA: src/devices.json). It answers,
// for one account, which apps it already has and how to get each of the others on the system the person is on, and
// draws that same answer as the devices section of Use Trillion in your AI (the welcome tour's devices step points at
// it), as start_setup's install.devices, and as the setup prompt's {devices_step}, so all three always agree.
//
// Non-negotiable invariants:
// - No device kind, app name, system or link is named here; each is a row of src/devices.json.
// - Installed is read from the account's own sign-ins (the names its apps signed in under), never asked of the person.
// - A link that is not public yet is never invented: its row's `not_yet` words are said instead.
// - Each link opens in a new tab (the guide opens every outside address that way), so the person keeps their place.
// - A scan code is drawn only for a link listed in src/devices.json (deviceScanCode), shown where scan_on names the
//   person's system.
// - A screen that needs something only an app brings (brings, DATA) offers exactly the apps that bring it and that the
//   account does not have yet (appsThatBring); it names the thing, never an app.
import rows from './devices.json' with { type: 'json' };
import { renderSVG } from 'uqr';
import { logoOf } from '../../set-up-my-account/read-data/site-icon-url.mjs';
import { observedInstallWays } from './device-distribution.mjs';

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => (values[name] ?? whole));

/** The id of the system a User-Agent (a browser's, or an AI app's) comes from, or null when it does not say. */
export function systemOf(userAgent) {
  const text = String(userAgent ?? '');
  return rows.systems.find(system => system.user_agent_has.some(mark => text.includes(mark)))?.id ?? null;
}

/** Browser hints only choose installation guidance; completion still comes from this account's app sign-in. */
export function installationObserver(userAgent) {
  for (const row of rows.distribution?.observers ?? []) {
    const match = new RegExp(row.user_agent_pattern).exec(String(userAgent ?? ''));
    if (match) return { device_family: row.device_family, os_version: match[1]?.replaceAll('_', '.') ?? null };
  }
  return null;
}

// The ways to get one app on `system`: the entries made for it, or every entry when none is (the system is not known,
// or the app is for another kind of device, such as a computer app looked at from a phone).
function waysOnto(device, system, distribution, now, observer) {
  const fits = device.get.filter(entry => entry.systems === 'any' || (system !== null && entry.systems.includes(system)));
  return (fits.length ? fits : device.get).flatMap(entry => observedInstallWays(entry, distribution, now, observer));
}

/**
 * Every app for one account. signedInAs: the names the account's sign-ins were made under; system: an id from
 * systemOf, or null. Each: { id, title, body, installed, get: [{ systems, label, href, not_yet? }] }.
 */
export function devicesFor({ signedInAs = [], system = null, distribution = null, now = Date.now(), observer = null } = {}) {
  const names = new Set(signedInAs);
  return rows.devices.map(device => ({
    id: device.id,
    title: device.title,
    domain: device.domain,
    body: device.body,
    installed: device.installed_when.signs_in_as.some(name => names.has(name)),
    brings: device.brings ?? [],
    ...(device.once_installed ? { once_installed: device.once_installed } : {}),
    ...(system !== null && device.scan_on?.includes(system) ? { scan: true } : {}),
    get: waysOnto(device, system, distribution, now, observer),
  }));
}

/**
 * Every app for one account as facts for the screen that lists them (Use Trillion in your AI, the catalogue screen
 * tool:ai in records/marketplace-screens.json): the section's own words, the asking device's system in words, and one
 * row per app with whether the account has it (then what it offers next, such as a tour), its published links, its
 * honest not-yet words, its access recovery and, where it is offered as one, the code a phone scans.
 */
export function devicesFacts({ devices, system = null }) {
  const label = rows.systems.find(row => row.id === system)?.label ?? null;
  const { heading, body, installed, not_yet: notYet, scan } = rows.words;
  return {
    words: { heading, body, installed, not_yet: notYet, scan },
    system_words: label ? fill(rows.words.on_this_device, { system: label }) : null,
    rows: devices.map(device => {
      const links = device.get.filter(entry => entry.href).map(entry => ({ label: entry.label, href: entry.href }));
      const recovery = device.get.filter(entry => !entry.href && entry.recovery?.href).map(entry => entry.recovery);
      const next = device.installed && device.once_installed ? { label: device.once_installed.label, tour: device.once_installed.tour ?? null, queue: device.once_installed.queue ?? null } : null;
      return {
        id: device.id, title: device.title, logo: logoOf(device.domain), installed: device.installed, offered: links.length > 0,
        detail: device.installed || links.length ? device.body : device.get.filter(entry => !entry.href).map(entry => entry.not_yet).join(' '),
        next, links: device.installed ? [] : links, recovery: device.installed ? [] : recovery,
        has_actions: device.installed ? next !== null : links.length + recovery.length > 0,
        scan_src: device.scan && !device.installed && links.length ? scanAddress(links[0].href) : null,
      };
    }),
  };
}

/**
 * The apps that bring one thing a web page cannot (`brings` in src/devices.json, such as listen), as facts for the screen
 * that offers them (the get-the-app catalogue screen, records/marketplace-screens.json, drawn by src/screen-layout.mjs):
 * only the ones this account does not have yet and that have a link for the person's system, each with its published
 * links, its honest not-yet words, its access recovery and, where it is offered as one, the code a phone scans. `words`
 * is that thing's own heading and body, or null when no row brings it (so nothing is offered).
 */
export function appsThatBringFacts({ devices, thing }) {
  const said = rows.words.brings?.[thing] ?? null;
  const offered = said ? devices.filter(device => device.brings.includes(thing) && !device.installed && device.get.some(entry => entry.href || entry.recovery?.href)) : [];
  return {
    thing,
    words: said,
    offered: offered.map(device => {
      const links = device.get.filter(entry => entry.href).map(entry => ({ label: entry.label, href: entry.href }));
      return {
        id: device.id, title: device.title, logo: logoOf(device.domain), body: device.body, links,
        waiting: device.get.filter(entry => !entry.href).map(entry => entry.not_yet).join(' '),
        recovery: device.get.filter(entry => !entry.href && entry.recovery?.href).map(entry => entry.recovery),
        scan_src: device.scan && links.length ? scanAddress(links[0].href) : null,
      };
    }),
  };
}

/** Where a published app link is drawn as a code to scan. */
export const scanAddress = href => `/devices/scan?to=${encodeURIComponent(href)}`;

/** The scan code of one published app link, as an SVG picture, or null for any address that is not one (so the route
 *  draws only Trillion's own app links, never an address someone passes it). */
export function deviceScanCode(href, distribution = null, now = Date.now()) {
  const published = devicesFor({ distribution, now }).some(device => device.get.some(entry => entry.href === href || entry.recovery?.href === href));
  return published ? renderSVG(href) : null;
}

/** The setup prompt's step: every app with its link, or its honest not-yet words (no account is known there). */
export function devicesStep() {
  const lines = devicesFor().map(device => `\n   - ${device.title}: ${device.get.map(entry => (entry.href ? `${entry.label}, ${entry.href}` : [entry.not_yet, entry.recovery ? `${entry.recovery.label}: ${entry.recovery.href}` : ''].filter(Boolean).join(' '))).join(' ')}`);
  return fill(rows.words.setup_step, { devices: lines.join('') });
}
