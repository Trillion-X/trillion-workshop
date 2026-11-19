/**
 * notice-when-something-shows-up/do-work/mechanisms/service-lists.mjs
 *
 * Purpose
 *   One waiting mechanism: read a list a service keeps (its bookings, messages,
 *   orders) every look_again_seconds, compare it with the last read, and report
 *   each thing added, changed or removed. It is for a service that cannot call
 *   out, and for a computer that slept while a service was calling: what changed
 *   meanwhile is still in the list, so nothing is lost, only late.
 *
 * Non-negotiable invariants
 *   - It names no service. Where the list is and how it is asked for is the
 *     waiter row's `request`; where each thing sits in the answer is its `shape`.
 *     A new service is a new row, never an edit here.
 *   - The credential is read from a descriptor (`credential_fd`) and placed only
 *     in the request headers the row names; it is never returned, logged or kept.
 *   - The kept state is one short fingerprint per thing in the last read, so the
 *     next read (after a restart too) tells only what differs. The first read
 *     tells nothing unless `tell_what_is_there_at_first` is true: what was
 *     already there did not change.
 *   - A thing missing from the next read is told as removed only when the row
 *     says the list is whole (`list_is_whole`), never for a list read in part.
 *   - A tell the engine refused stops the read; the state is not moved past it,
 *     so it is told again next time.
 *   - What kind of change a thing is (`kinds`) is decided here, by the row's
 *     `shape.kinds` rules, because only this read holds the whole thing: a fact
 *     field carries at most 1,000 bytes, and a booking or a message is larger. The
 *     kind names are the ones the person's workflows' fires_when conditions read;
 *     no kind is named in this code.
 *
 * Settings (mechanism_settings)
 *   where               the connection's name (no secret)
 *   credential_fd       the descriptor holding the credential (default 4; a waiter that names its own credential_name reads it from the descriptor the run gave it instead)
 *   request             { url, method?: "GET", headers?: { <name>: "<text with {credential}>" } }
 *   shape               { items: "<path to the list>", place: "<path>" | { value }, key: "<path>" | [..],
 *                         at?: "<path>", at_unit?: "seconds" | "ms" | "iso", next?: "<path to the next page's url>",
 *                         kinds?: [{ change?: "added" | "changed" | "removed", has?: "<path>", lacks?: "<path>", kinds: [..] }],
 *                         carry?: ["<path>", ..] | { <name>: "<path>" | ["<path>", ..] } }
 *                       kinds: every rule whose change, has (a value is there) and lacks (no value is there) hold
 *                         adds its kinds; the fact's `kinds` is their list as JSON text, null when none holds.
 *                       carry: the values that make the fact's `after`, so a thing too large for one fact field still
 *                         carries the parts its readers need: a list of paths (each kept under its own path), or names
 *                         to paths, so a service's own field names become the words its readers read (a booking's start
 *                         under starts_at whatever the service calls it); left out, the whole thing.
 *   list_is_whole       true when one read returns every thing that exists
 *   most_pages          the most pages one read follows (default 10)
 *   look_again_seconds  how long between reads (default 300)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::service-lists";
export const CARRIED_BYTES = 1000;

export const carried = (value) => {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text) <= CARRIED_BYTES ? text : null;
};

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "before", "after", "kinds"],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const number = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    where: typeof settings.where === "string" ? settings.where : "",
    credential_fd: Number.isInteger(Number(settings.credential_fd)) && Number(settings.credential_fd) >= 0 ? Number(settings.credential_fd) : 4,
    request: settings.request ?? null,
    shape: settings.shape ?? null,
    list_is_whole: settings.list_is_whole === true,
    tell_what_is_there_at_first: settings.tell_what_is_there_at_first === true,
    most_pages: number(settings.most_pages, 10),
    look_again_ms: number(settings.look_again_seconds, 300) * 1000,
  };
}

export function at(value, path) {
  if (Array.isArray(path)) {
    for (const one of path) { const found = at(value, one); if (found !== undefined && found !== null) return found; }
    return undefined;
  }
  if (typeof path !== "string" || path === "") return value;
  return path.split(".").reduce((current, step) => (current === null || current === undefined ? undefined : current[step]), value);
}

const fingerprint = (item) => createHash("sha256").update(JSON.stringify(item)).digest("base64url").slice(0, 16);

function isoOf(value, unit) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  const time = unit !== "iso" && Number.isFinite(number) ? new Date(unit === "ms" ? number : number * 1000) : new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

const present = (value) => value !== undefined && value !== null && value !== "";

/** The kinds the row's `shape.kinds` rules give one change of `item` (null for a removed thing), as JSON text or null. */
export function kindsOf(rules, change, item) {
  if (!Array.isArray(rules)) return null;
  const kinds = [];
  for (const rule of rules) {
    if (rule?.change !== undefined && rule.change !== change) continue;
    if (rule?.has !== undefined && !present(at(item ?? {}, rule.has))) continue;
    if (rule?.lacks !== undefined && present(at(item ?? {}, rule.lacks))) continue;
    for (const kind of Array.isArray(rule?.kinds) ? rule.kinds : []) if (typeof kind === "string" && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length ? JSON.stringify(kinds) : null;
}

/** What the fact's `after` carries of `item`: the row's `shape.carry` values when it names them, else the whole thing. */
export function carriedOf(carry, item) {
  if (carry === undefined || carry === null) return carried(item);
  const named = Array.isArray(carry) ? carry.map((path) => [path, path]) : Object.entries(carry);
  return carried(Object.fromEntries(named.map(([name, path]) => [name, at(item, path) ?? null])));
}

/** Read every page of the list once. Answers {items} or throws with words. */
export async function readList(own, credential, fetchImpl = fetch) {
  if (!own.request?.url || !own.shape?.items) throw new Error("This waiter row names no request url or no items path.");
  const headers = Object.fromEntries(Object.entries(own.request.headers ?? {}).map(([name, value]) => [name, String(value).replaceAll("{credential}", credential)]));
  const items = [];
  let url = own.request.url;
  for (let page = 0; url && page < own.most_pages; page += 1) {
    const response = await fetchImpl(url, { method: own.request.method ?? "GET", headers });
    if (!response.ok) throw new Error(`The service answered ${response.status} for its list.`);
    const answer = await response.json();
    const found = at(answer, own.shape.items);
    if (!Array.isArray(found)) throw new Error("The service's answer holds no list at the row's items path.");
    items.push(...found);
    url = own.shape.next ? at(answer, own.shape.next) : null;
  }
  return { items, whole: own.list_is_whole && !url };
}

/** What differs between the kept fingerprints and this read: each change's fact fields, oldest first. */
export function compare({ own, seen, items, whole, readAt = new Date() }) {
  const now = {};
  const changes = [];
  for (const item of items) {
    const key = at(item, own.shape.key);
    if (key === undefined || key === null) continue;
    const id = String(key);
    const print = fingerprint(item);
    now[id] = print;
    if (seen[id] === print) continue;
    const place = typeof own.shape.place === "object" && own.shape.place !== null && "value" in own.shape.place ? own.shape.place.value : at(item, own.shape.place);
    changes.push({
      key: id, print,
      detail: { where: own.where, place: String(place ?? ""), change: seen[id] === undefined ? "added" : "changed",
        at: isoOf(own.shape.at ? at(item, own.shape.at) : null, own.shape.at_unit) ?? readAt.toISOString(),
        key: id, before: null, after: carriedOf(own.shape.carry, item), kinds: kindsOf(own.shape.kinds, seen[id] === undefined ? "added" : "changed", item) },
    });
  }
  if (whole) {
    for (const id of Object.keys(seen)) {
      if (id in now) continue;
      const place = typeof own.shape.place === "object" && own.shape.place !== null && "value" in own.shape.place ? own.shape.place.value : "";
      changes.push({ key: id, print: null, detail: { where: own.where, place: String(place), change: "removed", at: readAt.toISOString(), key: id, before: null, after: null, kinds: kindsOf(own.shape.kinds, "removed", null) } });
    }
  }
  changes.sort((a, b) => a.detail.at.localeCompare(b.detail.at));
  return { changes, now };
}

/**
 * Read, compare and report, until stopped.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, signal, state ({seen}), keepState, and for tests: credential, fetch, now
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const keepState = handlers.keepState ?? (async () => {});
  const credential = handlers.credential ?? readFileSync(handlers.credentialFd ?? own.credential_fd, "utf8").trim();
  let state = handlers.state?.seen ? handlers.state : null;
  try {
    while (!signal?.aborted) {
      const { items, whole } = await readList(own, credential, handlers.fetch ?? fetch);
      const readAt = new Date(handlers.now?.() ?? Date.now());
      if (state === null && !own.tell_what_is_there_at_first) {
        state = { seen: compare({ own, seen: {}, items, whole: false, readAt }).now };
        await keepState(state);
      } else {
        const seen = { ...(state?.seen ?? {}) };
        const { changes } = compare({ own, seen, items, whole, readAt });
        for (const one of changes) {
          if (signal?.aborted) return;
          const next = { ...seen };
          if (one.print === null) delete next[one.key]; else next[one.key] = one.print;
          const told = await handlers.onTransition({ condition: "became-reachable", observed_identity: { where: own.where, place: one.detail.place },
            event_key: `${own.where}:${one.detail.place}:${one.key}:${one.detail.change}:${one.print ?? one.detail.at}`, state: { seen: next }, detail: one.detail });
          if (told === false) break;
          Object.assign(seen, next); for (const id of Object.keys(seen)) if (!(id in next)) delete seen[id];
        }
        state = { seen };
        await keepState(state);
      }
      if (signal?.aborted) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, own.look_again_ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  } finally {
    if (state) await keepState(state).catch(() => {});
  }
}
