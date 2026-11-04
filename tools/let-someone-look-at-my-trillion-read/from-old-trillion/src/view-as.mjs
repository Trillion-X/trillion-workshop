// src/view-as.mjs
//
// PURPOSE
//   Letting someone see your Trillion, read only (DATA: src/view-as.json). The owner lets one person look for a few
//   days, by the email their Trillion account uses; that person opens the owner's Home exactly as the owner sees it.
//   A look is a look-only sign-in of the owner's account (src/screen-pictures.mjs lookSessionAllows: GET and HEAD only,
//   the page and its /work/api reads, ending at its own time), named for the person looking, so the Worker refuses
//   every change for it and the page keeps nothing of the owner's on the looker's device.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nobody looks without the owner's permission: a look starts only from a permission the owner gave the person
//      looking (by their account, found from the email, or the account that opened the owner's look link), still in
//      its days. Its id is a hash of both accounts, so it names nobody and cannot be guessed into another's.
//      Permissions live in one place, the owner's policy directory (src/account-control.mjs, `permissions` below), which
//      answers at once and the same everywhere; KV keeps only what points at them (which owner an id belongs to, and
//      each looker's list of Trillions they may look at), never whether a look is allowed.
//   2. A look is read only and short: a look-only sign-in (invariant above) lasting at most `look_minutes` and never
//      past the permission. It is never renewed.
//   3. Stopping a permission ends every look open under it at once: every request of a look asks the owner's policy directory
//      whether its permission still stands (acceptsLook), so a look sign-in still held in KV's copies opens nothing.
//      The owner's "disconnect everything" ends them too (a look carries the owner's sign-in generation).
//   4. The owner is told every time a look starts (the caller's `told`), and the newest looks are kept for them.
//   5. The looker's own sign-in is held aside in its own cookie while they look and given back when they stop; it is
//      never sent to the owner's account or read by the page.
//   6. A look link gives leave to whoever opens it first while signed in (never the owner), once, within
//      `link_open_days`; only its hash is kept, so the stored record cannot be turned back into the link.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from '../../../view-as/src/view-as.json' with { type: 'json' };
import { accountsForEmail, normalEmail } from '../../../start-from-any-landing-page/src/sign-in-email.mjs';

export const viewAsSettings = settings;
export const viewAsSaid = (key, values = {}) => settings.words[key].replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
/** What the owner is told when a look starts (invariant 4): one notice per look, opening their Privacy screen. */
export const lookedNotice = ({ name, at, until }) => ({
  key: `someone-looked:${at}`, kind: settings.notice_kind, title: viewAsSaid('notice_title', { name }),
  body: viewAsSaid('notice_body', { minutes: Math.max(1, Math.round((Date.parse(until) - Date.parse(at)) / 60_000)) }), refs: { open: '/settings/privacy' },
});

const encoder = new TextEncoder();
const LOOK_CONTEXT = encoder.encode('trillion 2026-10-05 view-as permission');
const lookId = (owner, viewer) => bytesToHex(blake3(encoder.encode(`${owner}\n${viewer}`), { context: LOOK_CONTEXT })).slice(0, 32);
const pointerKey = id => `view-grant:${id}`;
const toViewerKey = viewer => `view-grants-to:${viewer}`;
const inviteKey = code => `view-invite:${bytesToHex(blake3(encoder.encode(code)))}`;
const DAY = 86_400_000;
const live = (rows, now) => rows.filter(row => Date.parse(row.until) > now);
const readList = async (kv, key, now) => live((await kv.get(key, 'json')) ?? [], now);
const writeList = (kv, key, rows) => (rows.length ? kv.put(key, JSON.stringify(rows)) : kv.delete(key));
const ttl = (until, now) => Math.max(60, Math.ceil((Date.parse(until) - now) / 1000));

/**
 * The owner's permissions as their policy directory keeps them: rows { who, until, entries: [{ id, viewer }] }, one per person
 * let look (a second leave for the same `who` replaces the first). The policy directory calls these on its own rows, so the one
 * definition of what a permission is lives here and the one copy of the permissions lives there.
 */
export const permissions = {
  live: (rows, now = Date.now()) => live(rows ?? [], now),
  grant: (rows, { who, until, entries }, now = Date.now()) => [...live(rows ?? [], now).filter(row => row.who !== who), { who: String(who), until: String(until), entries: entries.map(({ id, viewer }) => ({ id: String(id), viewer: String(viewer) })) }],
  stop: (rows, who, now = Date.now()) => {
    const kept = live(rows ?? [], now);
    return { row: kept.find(row => row.who === who) ?? null, rows: kept.filter(row => row.who !== who) };
  },
  of: (rows, id, now = Date.now()) => {
    for (const row of live(rows ?? [], now)) {
      const entry = row.entries.find(item => item.id === id);
      if (entry) return { viewer: entry.viewer, until: row.until };
    }
    return null;
  },
};

export class ViewAsError extends Error {}

const daysOf = days => {
  const span = Number(days);
  if (!settings.days.includes(span) || span > settings.most_days) throw new ViewAsError(viewAsSaid('bad_days'));
  return span;
};

// Gives `viewers` (one person's accounts) leave to look at `owner`'s Trillion until `until`, listed for the owner as
// `who`: the permission is kept in the owner's policy directory (`policyOf(owner)`, src/account-policy-name.mjs
// accountPolicyFor: the owner's user id in, every call made for its owner id), and KV points each id at its owner and lists it
// for each viewer.
async function grant({ kv, policyOf, owner, who, viewers, until, ownerName, now }) {
  const entries = viewers.map(viewer => ({ id: lookId(owner, viewer), viewer }));
  await policyOf(owner).letLookGrant({ who, until, entries });
  for (const { id, viewer } of entries) {
    await kv.put(pointerKey(id), JSON.stringify({ owner, viewer }), { expirationTtl: ttl(until, now) });
    const toViewer = (await readList(kv, toViewerKey(viewer), now)).filter(row => row.id !== id);
    await writeList(kv, toViewerKey(viewer), [...toViewer, { id, name: ownerName, until }]);
  }
  return { who, until, ids: entries.map(entry => entry.id) };
}

/**
 * The owner lets the account using `email` look for `days`; `nameOf(userId)` is an account's shown name (the caller
 * reads it), kept on the looker's row. Returns { who, until }.
 */
export async function letLook({ kv, policyOf, owner, email, days, nameOf, now = Date.now() }) {
  const address = normalEmail(email);
  if (!address) throw new ViewAsError(viewAsSaid('bad_email'));
  const span = daysOf(days);
  const accounts = await accountsForEmail(kv, address);
  const viewers = accounts.filter(id => id !== owner);
  if (!viewers.length) throw new ViewAsError(viewAsSaid(accounts.includes(owner) ? 'not_yourself' : 'no_account'));
  const { who, until } = await grant({ kv, policyOf, owner, who: address, viewers, until: new Date(now + span * DAY).toISOString(), ownerName: await nameOf(owner), now });
  return { who, until };
}

/**
 * The owner makes a link that gives leave to look for `days` to whoever opens it first, signed in (for someone whose
 * email Trillion does not know): one use, open for `link_open_days`. Returns { code }; the caller makes the address.
 */
export async function makeLookLink({ kv, owner, days, random, now = Date.now() }) {
  const span = daysOf(days);
  const code = random();
  const opens_until = new Date(now + settings.link_open_days * DAY).toISOString();
  await kv.put(inviteKey(code), JSON.stringify({ owner, days: span, opens_until }), { expirationTtl: ttl(opens_until, now) });
  return { code, opens_until };
}

/** The account `viewer` opens a look link: it becomes their leave (the link is used up), answering { id, owner } to
 *  look under, or null for a link used, ended, or their own. */
export async function takeLookLink({ kv, policyOf, code, viewer, nameOf, now = Date.now() }) {
  if (typeof code !== 'string' || !/^[0-9a-f]{64}$/.test(code)) return null;
  const invite = await kv.get(inviteKey(code), 'json');
  if (!invite || invite.owner === viewer || !(Date.parse(invite.opens_until) > now)) return null;
  await kv.delete(inviteKey(code));
  const who = await nameOf(viewer);
  const granted = await grant({ kv, policyOf, owner: invite.owner, who, viewers: [viewer], until: new Date(now + invite.days * DAY).toISOString(), ownerName: await nameOf(invite.owner), now });
  return { id: granted.ids[0], owner: invite.owner };
}

/** The owner stops letting `who` look; every look open under it is refused from now (invariant 3). */
export async function stopLetting({ kv, policyOf, owner, who, now = Date.now() }) {
  const row = await policyOf(owner).letLookStop(who);
  if (!row) return { who, stopped: false };
  for (const { id, viewer } of row.entries) {
    await kv.delete(pointerKey(id));
    await writeList(kv, toViewerKey(viewer), (await readList(kv, toViewerKey(viewer), now)).filter(item => item.id !== id));
  }
  return { who, stopped: true };
}

/** Who the owner lets look ({ who, until }, from their policy directory) and whose Trillions this account may look at
 *  ({ id, name, until }). */
export async function looking({ kv, policy, userId, now = Date.now() }) {
  const [letting, lettingMe] = await Promise.all([policy.letLooking(), readList(kv, toViewerKey(userId), now)]);
  return { letting, letting_me: lettingMe };
}

/**
 * Starts a look for `viewer` under permission `id` (of `owner` when the caller knows it, else read from where KV points
 * it): when the owner's policy directory says the permission stands for this viewer now (invariant 1), keeps a look-only sign-in of
 * the owner's account in `kv` (invariant 2), named by `hash` of a `random` token and carrying its permission (`grant`),
 * and answers { token, owner, until }; otherwise null.
 */
export async function startLook({ kv, policyOf, id, owner = null, viewer, hash, random, now = Date.now() }) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null;
  const whose = owner ?? (await kv.get(pointerKey(id), 'json'))?.owner;
  if (!whose) return null;
  const permission = await policyOf(whose).letLookPermission(id);
  if (!permission || permission.viewer !== viewer || !(Date.parse(permission.until) > now)) return null;
  const until = new Date(Math.min(Date.parse(permission.until), now + settings.look_minutes * 60_000)).toISOString();
  const token = random();
  await kv.put(`session:${hash(token)}`, JSON.stringify({ userId: whose, created_at: new Date(now).toISOString(), browser_generation: permission.generation, look_only: true, path: '/', viewer, grant: id, expires_at: until }), { expirationTtl: ttl(until, now) });
  return { token, owner: whose, until };
}

/** A time as the looking screens say it. */
export const shortDay = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

/**
 * The Privacy screen's sections for looking: letting someone look (a form and each permission with Stop), the
 * Trillions this account may look at (each with Look), and who looked lately. facts: looking() plus `looks` (the
 * owner's kept looks, newest last).
 */
export function lookingSections({ letting = [], letting_me: lettingMe = [], looks = [] }) {
  const words = settings.words;
  const days = settings.days.map(count => ({ value: String(count), label: count === 1 ? words.day_one : viewAsSaid('day_many', { days: count }) }));
  return [
    {
      id: 'let-someone-look',
      heading: words.heading,
      body: words.body,
      rows: [
        {
          id: 'let-look',
          title: words.let,
          starts_open: !letting.length,
          fields: [
            { name: 'email', label: words.email_label, secret: false, placeholder: words.email_placeholder },
            { name: 'days', label: words.days_label, kind: 'choice', options: days, value: days[0].value },
          ],
          actions: [
            { label: words.let, tone: 'primary', send: { path: '/work/api/account/looking/let', with_fields: true } },
            { label: words.link, tone: 'quiet', send: { path: '/work/api/account/looking/link', with_fields: true } },
          ],
        },
        ...letting.map(row => ({
          id: `letting-${row.who}`,
          title: viewAsSaid('letting', { who: row.who, until: shortDay(row.until) }),
          actions: [{ label: words.stop, tone: 'quiet', send: { path: '/work/api/account/looking/stop', body: { who: row.who }, confirm: viewAsSaid('stop_confirm', { who: row.who }) } }],
        })),
        ...looks.slice(-5).reverse().map(look => ({ id: `looked-${look.at}`, title: viewAsSaid('looked_row', { name: look.name }), detail: shortDay(look.at) })),
      ],
    },
    ...(lettingMe.length ? [{
      id: 'trillions-i-can-look-at',
      heading: words.letting_me_heading,
      rows: lettingMe.map(row => ({
        id: `look-${row.id}`, title: viewAsSaid('letting_me_row', { name: row.name }), detail: viewAsSaid('letting_me_detail', { until: shortDay(row.until) }),
        actions: [{ label: words.open, tone: 'primary', href: `/view-as/${row.id}` }],
      })),
    }] : []),
  ];
}
