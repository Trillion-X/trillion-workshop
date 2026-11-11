// tools/publish-an-engine-release/do-work/release-feed.mjs
//
// The release feed's own rules, with no file, network or process: the text a release's signature covers, signing and
// checking it with Ed25519, a signing key's public half as 64 hex, and adding one entry to a feed (`{ releases }`,
// newest last, at most `keep_releases`, each target's newest always kept), which refuses a sequence older than the
// newest one for the same target. Every target is one entry per commit in the same feed: a target is data, and
// another builder (one per target it builds for) hands its signed entry to the feed's builder (`accept`).
// The engine's feed reader (engine job J1) reads the same format.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const settings = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));

/** The engine release roads: the rust targets every commit is published for, each row built as `host`, `darwin` or `zigbuild`. */
export const roads = JSON.parse(readFileSync(new URL('../read-data/release-roads.json', import.meta.url), 'utf8'));

const refuse = (message, exit = 1) => Object.assign(new Error(message), { exit });
const commitPattern = new RegExp(settings.commit_pattern), targetPattern = new RegExp(settings.target_pattern);
const ENTRY_FIELDS = ['commit', 'sequence', 'target', 'url', 'content', 'bytes', 'urgent', 'signature'];

export function checkCommit(commit) {
  if (typeof commit !== 'string' || !commitPattern.test(commit)) throw refuse(`${JSON.stringify(commit)} is not a commit id: send the full lowercase hex id (git rev-parse).`, 2);
  return commit;
}

export function checkTarget(target) {
  if (typeof target !== 'string' || !targetPattern.test(target)) throw refuse(`${JSON.stringify(target)} is not a rust target triple like x86_64-unknown-linux-gnu (the host line of rustc -vV).`);
  return target;
}

/** The exact text a release's signature covers. */
export function signedText({ commit, sequence, target, content, bytes, urgent }) {
  return [settings.signing_domain, commit, sequence, target, content, bytes, urgent ? 'true' : 'false'].join('\n');
}

/** A new Ed25519 signing key as PKCS#8 PEM text, made only by `make-key` on the builder. */
export function newSigningKey() {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
}

/** The 32-byte public key of a PEM private key (or of a KeyObject), as 64 lowercase hex. */
export function publicKeyHex(privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

/** The entry with its signature: 128 hex. */
export function signEntry(entry, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw refuse('The signing key is not an Ed25519 key: make it again with `make-key` on the builder.');
  return { ...entry, signature: sign(null, Buffer.from(signedText(entry), 'utf8'), key).toString('hex') };
}

/** Whether the entry's signature verifies with a public key given as 64 hex. */
export function verifyEntry(entry, publicHex) {
  if (!/^[0-9a-f]{64}$/.test(publicHex ?? '') || !/^[0-9a-f]{128}$/.test(entry?.signature ?? '')) return false;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicHex, 'hex')]);
  return verify(null, Buffer.from(signedText(entry), 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(entry.signature, 'hex'));
}

/** An entry checked field by field; anything else in a feed is refused rather than carried. */
export function checkEntry(entry) {
  const where = `The feed entry ${JSON.stringify(entry?.commit ?? null)}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw refuse('A feed entry must be a JSON object.');
  const extra = Object.keys(entry).filter(key => !ENTRY_FIELDS.includes(key));
  if (extra.length) throw refuse(`${where} has fields a feed entry does not take: ${extra.join(', ')}.`);
  checkCommit(entry.commit);
  checkTarget(entry.target);
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) throw refuse(`${where} has a sequence that is not a whole number above 0.`);
  if (typeof entry.url !== 'string' || !entry.url.startsWith('https://')) throw refuse(`${where} has a url that is not https.`);
  if (!/^1f:[0-9a-f]{64}$/.test(entry.content ?? '')) throw refuse(`${where} has a content that is not 1f: and 64 hex.`);
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw refuse(`${where} has a byte count that is not a whole number above 0.`);
  if (typeof entry.urgent !== 'boolean') throw refuse(`${where} has an urgent that is not true or false.`);
  if (!/^[0-9a-f]{128}$/.test(entry.signature ?? '')) throw refuse(`${where} has a signature that is not 128 hex.`);
  return entry;
}

/** A feed read from its text (a missing feed is the empty feed). */
export function readFeed(text) {
  if (text === null || text === undefined) return { releases: [] };
  let feed;
  try { feed = JSON.parse(text); } catch { throw refuse('feed.json is not JSON: move it aside, and the next publish starts a new feed.'); }
  if (!feed || !Array.isArray(feed.releases)) throw refuse('feed.json has no releases list: it must be { "releases": [ ... ] }.');
  feed.releases.forEach(checkEntry);
  return { releases: feed.releases };
}

/**
 * Each road's state for one commit: its newest feed entry when that is the commit, else a gap with its cause (the
 * last failure this run recorded for the target, or that no builder has published the commit for it yet). Pure: the
 * caller writes it as feed-status.json beside feed.json, so a missing target is visible, never silently skipped.
 */
export function feedStatusOf(feed, commit, targets, failures = {}) {
  const at = {};
  for (const target of targets) {
    const newest = newestFor(feed, target);
    at[target] = newest?.commit === commit
      ? { commit, sequence: newest.sequence, state: 'published' }
      : { commit: newest?.commit ?? null, sequence: newest?.sequence ?? null, state: 'gap', cause: failures[target] ?? `no entry for ${commit} yet` };
  }
  return { commit, targets: at };
}

/** The newest entry the feed holds for one target, or null. */
export const newestFor = (feed, target) => feed.releases.filter(entry => entry.target === target).reduce((newest, entry) => (!newest || entry.sequence > newest.sequence ? entry : newest), null);

/**
 * Whether `{ commit, sequence, target }` may be published into the feed: `{ already }` when that very release is
 * there, else nothing; an older sequence (or another commit at the same sequence) for the same target is refused.
 */
export function mayPublish(feed, { commit, sequence, target }) {
  const same = feed.releases.find(entry => entry.target === target && entry.commit === commit);
  if (same) return { already: same };
  const newest = newestFor(feed, target);
  if (newest && sequence < newest.sequence) throw refuse(`Commit ${commit} is sequence ${sequence}, older than the feed's newest ${target} release (${newest.commit}, sequence ${newest.sequence}): an older commit never replaces a newer one.`, 3);
  if (newest && sequence === newest.sequence) throw refuse(`Commit ${commit} has the same sequence (${sequence}) as the feed's ${target} release ${newest.commit}: the branch was rewritten; publish a new commit on top of it.`, 3);
  return {};
}

/** The feed with the entry added, newest last, and the entries that no longer fit. */
export function addRelease(feed, entry, keep = settings.keep_releases) {
  checkEntry(entry);
  const may = mayPublish(feed, entry);
  if (may.already) return { feed, added: false, entry: may.already, dropped: [] };
  const releases = [...feed.releases, entry].map((one, at) => ({ one, at })).sort((a, b) => a.one.sequence - b.one.sequence || a.at - b.at).map(({ one }) => one);
  // The oldest leave first, but never a target's newest: a target whose builder is behind (or down) keeps the
  // release its computers follow while the other targets' builders go on publishing into the same feed.
  const newest = new Set([...new Set(releases.map(one => one.target))].map(target => newestFor({ releases }, target)));
  const dropped = [];
  for (const one of releases) {
    if (releases.length - dropped.length <= keep) break;
    if (!newest.has(one)) dropped.push(one);
  }
  return { feed: { releases: releases.filter(one => !dropped.includes(one)) }, added: true, entry, dropped };
}

/** The first of `publicHexes` the entry's signature verifies with, or null: which builder signed it. */
export const signerOf = (entry, publicHexes) => (publicHexes ?? []).find(key => verifyEntry(entry, key)) ?? null;
