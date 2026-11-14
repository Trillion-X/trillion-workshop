#!/usr/bin/env node
// packages/visual-database/do-work/process-scripts/extract-dm-leads.mjs
//
// Purpose: turn decoded conversation atoms into CRM customer rows and lead-event
//   rows. Pure data mapping: atoms in, record writes out. No network, no clock,
//   no OS state.
//
// Non-Negotiable Invariants:
//   - ZERO business or channel vocabulary in this file. Which words signal buying
//     intent, and how a channel forms a contact identity, are DATA read from the
//     mounted descriptor. Adding a keyword or a channel is a DATA edit; this file
//     does not change. A conformance test greps this file for channel and keyword
//     vocabulary and fails if any appears.
//   - Self-describing first (L090): an atom's own decoder provenance names its
//     channel. Guessing a channel from substrings of a thread ref is what the
//     previous implementation did, and it is why adding a channel meant editing code.
//     A descriptor rule is the fallback, never the first source.
//   - Signals are ordered DATA and the first match wins, so precedence is authored
//     rather than implied by the order somebody wrote if-statements in.
//
// Usage: extract-dm-leads.mjs <atoms.json> <writes.json> [--descriptor <descriptor.json>]

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (value === null || value === undefined ? '' : String(value));

const arg = (flag, fallback = null) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
};

const readJson = (path, fallback) => {
  if (!path) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

/** A descriptor with no rules classifies nothing and identifies by thread ref. That is
 *  the honest empty state: it never invents a channel or a keyword of its own. */
const EMPTY_DESCRIPTOR = { signals: [], channel_rules: [], self_fields: [], handle_fields: [] };

const compilePattern = (pattern) => {
  if (typeof pattern?.regex === 'string') {
    // Compile ONCE, here, so a malformed pattern in DATA fails at compile time and
    // degrades to no-match. Building the RegExp inside the returned closure moves the
    // throw to match time, where it takes down the whole run instead.
    let compiled;
    try {
      compiled = new RegExp(pattern.regex, pattern.flags ?? 'i');
    } catch {
      return () => false;
    }
    return (value) => compiled.test(value);
  }
  if (typeof pattern?.phrase === 'string') {
    const needle = pattern.phrase.toLowerCase();
    return (value) => value.toLowerCase().includes(needle);
  }
  return () => false;
};

const compileSignals = (descriptor) =>
  (Array.isArray(descriptor.signals) ? descriptor.signals : []).map((signal) => ({
    key: text(signal.key),
    event_type: text(signal.event_type) || text(signal.key),
    tests: (Array.isArray(signal.patterns) ? signal.patterns : []).map(compilePattern),
  }));

/** First signal whose patterns match wins; DATA order is the precedence. */
const matchSignal = (body, signals) =>
  signals.find((signal) => signal.tests.some((test) => test(body))) ?? null;

const provenanceOf = (atom) => {
  const raw = atom.provenance;
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

/** The decoder that produced the atom knows its channel. Only when it did not say
 *  do we fall back to DATA-declared rules, and only then to the unnamed default. */
const channelOf = (atom, provenance, descriptor) => {
  const declared = text(provenance.channel || provenance.platform || atom.channel);
  if (declared) return declared;
  const threadRef = text(atom.thread_ref);
  for (const rule of Array.isArray(descriptor.channel_rules) ? descriptor.channel_rules : []) {
    const marker = text(rule.thread_ref_contains);
    const field = text(rule.provenance_field);
    if (marker && threadRef.toLowerCase().includes(marker.toLowerCase())) return text(rule.channel);
    if (field && provenance[field]) return text(rule.channel);
  }
  return text(descriptor.default_channel);
};

/** Inbound means "not us". Which provenance fields name us is DATA, because every
 *  channel spells its own account id differently. */
const isInbound = (atom, provenance, descriptor) => {
  const speaker = text(atom.speaker_ref);
  if (!speaker) return true;
  if (speaker === 'me') return false;
  const selves = new Set(
    (Array.isArray(descriptor.self_fields) ? descriptor.self_fields : [])
      .map((field) => text(provenance[field]))
      .filter(Boolean),
  );
  return !selves.has(speaker);
};

const bodyOf = (atom) => {
  const content = atom.content;
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return '';
};

const sanitize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** An identity template is DATA: "{channel}:{handle}" or whatever a channel uses.
 *  Unresolved placeholders fall back to the thread ref so an identity is never blank. */
const identityFor = (atom, provenance, channel, descriptor) => {
  const threadRef = text(atom.thread_ref);
  const handle = (Array.isArray(descriptor.handle_fields) ? descriptor.handle_fields : [])
    .map((field) => text(provenance[field]))
    .find(Boolean) ?? '';
  const template = text(
    (Array.isArray(descriptor.channel_rules) ? descriptor.channel_rules : [])
      .find((rule) => text(rule.channel) === channel)?.identity_template,
  ) || text(descriptor.identity_template) || '{channel}:{thread_ref}';
  const filled = template
    .replace('{channel}', channel)
    .replace('{handle}', handle)
    .replace('{thread_ref}', threadRef);
  return { identity: filled.includes('{') ? `${channel}:${threadRef}` : filled, handle };
};

const flattenAtoms = (decoded) => {
  const out = [];
  const push = (value) => {
    if (!isRecord(value)) return;
    for (const key of ['atoms', 'items', 'output']) {
      if (Array.isArray(value[key])) {
        out.push(...value[key].filter(isRecord));
        return;
      }
    }
    if ('thread_ref' in value && 'content' in value) out.push(value);
  };
  if (Array.isArray(decoded)) decoded.forEach(push);
  else push(decoded);
  return out;
};

const build = (decoded, descriptor) => {
  const signals = compileSignals(descriptor);
  const atoms = flattenAtoms(decoded);

  const threadsScanned = new Set();
  const threads = new Map();
  for (const atom of atoms) {
    const threadRef = text(atom.thread_ref);
    if (!threadRef) continue;
    threadsScanned.add(threadRef);
    const provenance = provenanceOf(atom);
    if (!isInbound(atom, provenance, descriptor)) continue;
    if (!threads.has(threadRef)) threads.set(threadRef, []);
    threads.get(threadRef).push(atom);
  }

  const writes = [];
  let customers = 0;
  let signalled = 0;

  for (const [threadRef, thread] of threads) {
    const inbound = [...thread].sort((a, b) => text(a.at).localeCompare(text(b.at)));
    const newest = inbound[inbound.length - 1];
    const provenance = provenanceOf(newest);
    const channel = channelOf(newest, provenance, descriptor);
    const { identity, handle } = identityFor(newest, provenance, channel, descriptor);
    const display = text(provenance.contact_name) || handle || identity.split(':').at(-1);

    writes.push({
      address: `package::visual-database::record::customer::${sanitize(identity)}`,
      path: ['current-item', 'published-record'],
      payload: {
        kind: 'customer',
        id: identity,
        title: display,
        channel,
        handle,
        first_seen: text(inbound[0].at),
        last_contacted: text(newest.at),
        source: `dm:${channel}`,
        sequences: [],
      },
    });
    customers += 1;

    const body = bodyOf(newest);
    const signal = matchSignal(body, signals);
    if (signal) signalled += 1;
    const eventType = signal ? signal.event_type : text(descriptor.default_event_type) || 'dm-inbound';
    const eventId = `${eventType}:${channel}:${threadRef}`;

    writes.push({
      address: `package::visual-database::record::lead-event::${sanitize(eventId)}`,
      path: ['current-item', 'published-record'],
      payload: {
        kind: 'lead-event',
        id: eventId,
        customer_ref: identity,
        event_type: eventType,
        signal_key: signal ? signal.key : null,
        channel,
        at: text(newest.at),
        detail: body.slice(0, 280),
        source_ref: text(newest.atom_ref),
        title: `DM from ${display}`,
      },
    });
  }

  return {
    writes,
    counts: {
      threads_scanned: threadsScanned.size,
      customers,
      dm_inbound: customers,
      signalled,
    },
  };
};

export { build, compileSignals, matchSignal, channelOf, isInbound, identityFor };

// Run the CLI only when this file IS the process entry. Tests import `build` directly
// to exercise descriptor behaviour, and an import must never write a file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , atomsPath, outPath] = process.argv;
  const descriptor = { ...EMPTY_DESCRIPTOR, ...readJson(arg('--descriptor'), {}) };
  writeFileSync(outPath, JSON.stringify(build(readJson(atomsPath, []), descriptor)), 'utf8');
}
