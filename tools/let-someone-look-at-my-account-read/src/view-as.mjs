// src/view-as.mjs
//
// PURPOSE
//   Letting someone see your own Trillion, read only (DATA: tools/view-as/src/view-as.json). The person's share is a grant of
//   read-only tools to a named person, kept at the sharer's own door by the engine (trillion-rust src/account_rights/share_grant.rs,
//   `sharing.keep` on `@own-records`), so the person runs exactly those tools with no copy on their own computer.
//   The old look sign-in (a look-only session of the owner's account, its own cookie and its banner) is RETIRED: every actor is a
//   user, and a special login for a look is the kind of login that was removed (Nov 20 2026 ruling, relayed by the lead).
//   Ported from the old app repository's src/view-as.mjs at commit b6ae0ebf815f2f5271eed34e6e023c7e1767ec04 (see moved-from.json and README.md).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A share names only the tools it lists and the people it names. Nothing here decides which tools are read only; the caller
//      passes them (DATA-free), and the engine refuses every tool a grant does not name.
//   2. A link gives its bearer only through its digest: the bearer is shown once to the person the owner hands it to, and only
//      BLAKE3(bearer) is kept, as the engine keeps it (share_grant.rs: "the bearer's bytes are never stored, logged or shown").
//   3. A share's end is the person's own rule (`ends`), kept beside the grant as given. This file builds `ends` from a day count;
//      the end is run by tools/end-a-grant-whose-condition-failed, which reads `ends` and nothing here.
//   4. Labels and people are capped the way the engine caps them (share-grant.json `act`): label at most 400 bytes, people at most
//      64, a principal of A-Z a-z 0-9 _ - from 1 to 128 characters, `identity` none or self, `journal` input or none.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from '../../view-as/src/view-as.json' with { type: 'json' };

export const viewAsSettings = settings;
export const viewAsSaid = (key, values = {}) => settings.words[key].replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

export class ViewAsError extends Error {}

const DAY = 86_400_000;
const SHARE_RESOURCE = '@own-records';
const KEEP = 'sharing.keep';
const WITHDRAW = 'sharing.withdraw';
const PRINCIPAL = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();
const BEARER_PREFIX = 'shr_';

const check = (ok, key) => { if (!ok) throw new ViewAsError(viewAsSaid(key)); };

/** The engine's share rules, checked here before a keep is sent so a refusal is said in the owner's words. */
export function sharingKeepInput({ label, tools, people, identity = 'none', journal = 'input', ends }) {
  const bytes = encoder.encode(String(label ?? '')).length;
  check(bytes >= 1 && bytes <= settings.share.most_label_bytes, 'bad_label');
  check(Array.isArray(tools) && tools.length > 0 && tools.every(tool => typeof tool === 'string' && tool.length > 0), 'bad_tools');
  check(Array.isArray(people) && people.length >= 1 && people.length <= settings.share.most_people, 'bad_people');
  check(people.every(person => PRINCIPAL.test(String(person?.principal ?? '')) && /^[0-9a-f]{64}$/.test(String(person?.key_blake3 ?? ''))), 'bad_people');
  check(identity === 'none' || identity === 'self', 'bad_identity');
  check(journal === 'input' || journal === 'none', 'bad_journal');
  return {
    resource: SHARE_RESOURCE,
    operation: KEEP,
    input: { label: String(label), on: true, sharing: { grant: { tools, identity, journal }, people, ...(ends ? { ends } : {}) } },
  };
}

/** The engine's withdraw of one shared label: ends its calls at the next call. */
export const sharingWithdrawInput = label => ({ resource: SHARE_RESOURCE, operation: WITHDRAW, input: { label: String(label) } });

/** The person's end rule from a day count: the share ends that many days from now, read by tools/end-a-grant-whose-condition-failed. */
export const endsAfterDays = (days, now = Date.now()) => {
  check(settings.days.includes(Number(days)) && Number(days) <= settings.most_days, 'bad_days');
  return { until: new Date(now + Number(days) * DAY).toISOString() };
};

const base64url = bytes => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * A link the owner hands to a person: a bearer (`shr_` + 32 random bytes, base64url) and the keep that names only its digest.
 * `random(n)` returns n random bytes (the caller supplies them). Answers { bearer, keep }: the bearer is shown once.
 */
export function shareLinkFor({ label, tools, random, ends, identity = 'none' }) {
  const bearer = BEARER_PREFIX + base64url(random(32));
  const key_blake3 = bytesToHex(blake3(encoder.encode(bearer)));
  const principal = `link-${key_blake3.slice(0, 16)}`;
  return { bearer, keep: sharingKeepInput({ label, tools, people: [{ principal, key_blake3 }], identity, ends }) };
}

/**
 * The Privacy screen's section for sharing: the form (a label, the days, the tools the caller offers), each share with Stop, and
 * a link. The actions send to the share operations on `@own-records`; nothing here names an old /view-as route.
 * facts: `shares` (the engine's sharing.list rows: { label, ends? }).
 */
export function sharingSections({ shares = [] }) {
  const words = settings.words;
  const days = settings.days.map(count => ({ value: String(count), label: count === 1 ? words.day_one : viewAsSaid('day_many', { days: count }) }));
  return [{
    id: 'share-my-tools',
    heading: words.heading,
    body: words.body,
    rows: [
      {
        id: 'share-form',
        title: words.let,
        starts_open: !shares.length,
        fields: [
          { name: 'label', label: words.label_label, secret: false, placeholder: words.label_placeholder },
          { name: 'days', label: words.days_label, kind: 'choice', options: days, value: days[0].value },
        ],
        actions: [
          { label: words.let, tone: 'primary', send: { resource: SHARE_RESOURCE, operation: KEEP, with_fields: true } },
          { label: words.link, tone: 'quiet', send: { resource: SHARE_RESOURCE, operation: KEEP, with_fields: true, link: true } },
        ],
      },
      ...shares.map(share => ({
        id: `shared-${share.label}`,
        title: viewAsSaid('letting', { who: share.label, until: share.ends?.until ? shortDay(share.ends.until) : words.never }),
        actions: [{ label: words.stop, tone: 'quiet', send: { ...sharingWithdrawInput(share.label), confirm: viewAsSaid('stop_confirm', { who: share.label }) } }],
      })),
    ],
  }];
}

/** A time as the sharing screens say it. */
export const shortDay = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
