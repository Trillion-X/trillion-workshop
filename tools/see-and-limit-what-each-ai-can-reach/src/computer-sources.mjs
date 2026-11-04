// src/computer-sources.mjs
//
// PURPOSE
//   What each of the person's computers found on itself: the Trillion Mac app looks for every source on the computer
//   (its notes, recordings, messages, mail, photos, drives, AI apps, the services its browsers use) the first time it
//   opens and on every launch after (media-workspace computer-sources.mjs), and reports what it found here. Connections
//   shows it, one section per computer, with the one switch the computer still needs, if any.
//
//   POST /computer-sources            { computer_id, name, sources, readers?, gates?, browser_sites? } -> { kept: true, computer_id }
//   GET  /computer-sources            -> { computers: [report] }
//   GET  /computer-sources/services   -> { services: [{ vendor, label, domains }] }: what a computer matches the sites its
//                                        browsers hold against, so only matching service names ever leave it
//   POST /computer-sources/forget     { computer_id } -> { forgotten: true }
//
// NON-NEGOTIABLE INVARIANTS
//   1. A report carries names, states, reader times and bounded failure words only: never what a source contains, never a browsing list, never a value read
//      from a login. The kept shape is fixed here and anything else a computer sends is dropped, so keeping contents
//      is impossible rather than discouraged.
//   2. One current report per computer, kept as one of the person's own records: a new report replaces that computer's
//      record and touches nothing else.
//   3. No source, app, service or place is named here. What a source is, its words and its switch are the computer's
//      own DATA rows; which services exist is the connect rows' DATA (invoke.connects.domain).
//   4. A state this file has no words for is shown in its own words, never guessed.

export const LIMITS = { computers: 20, sources: 300, readers: 300, browser_sites: 300, gates: 20, steps: 6, text: 300, id: 120 };

const text = (value, max = LIMITS.text) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const readerReason = value => {
  const words = text(value) ?? '';
  if (['working', 'starting', 'needs access', 'reader timed out', 'account could not be reached', 'reader failed'].includes(words)) return words;
  const code = words.match(/\b(?:account answered|HTTP)\s+(\d{3})\b/i)?.[1];
  if (code) return `the account answered ${code}${/media[_ -]?type/i.test(words) ? ' about a media type' : ''}`;
  return 'reader failed';
};
const instant = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

// The states a computer reports, in plain words, and how the screen marks each.
const STATE_WORDS = {
  reading: { label: 'Connected', tone: 'good' },
  found: { label: 'On this computer', tone: 'quiet' },
  needs_switch: { label: 'Needs one switch', tone: 'attention' },
  could_not_check: { label: 'Could not check', tone: 'attention' },
};
const stateOf = state => STATE_WORDS[state] ?? { label: state.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase()), tone: 'quiet' };

/** A report as it is kept: only the fields below, each bounded. Throws on a report that names no computer. */
export function keptReport(body = {}, at = new Date().toISOString()) {
  const computer_id = text(body.computer_id, LIMITS.id);
  if (!computer_id) throw new Error('computer_id is required: the id this computer keeps for itself.');
  const seen = new Set();
  const sources = (Array.isArray(body.sources) ? body.sources : []).map(source => ({
    id: text(source?.id, LIMITS.id),
    label: text(source?.label),
    category: text(source?.category, 60),
    state: text(source?.state, 40),
    detail: text(source?.detail),
    gate: text(source?.gate, LIMITS.id),
  })).filter(source => source.id && source.label && source.state && !seen.has(source.id) && seen.add(source.id)).slice(0, LIMITS.sources);
  // Only reader timing and bounded failure words cross from the computer. Item ids and contents are discarded.
  const readerRoutes = new Set();
  const readers = (Array.isArray(body.readers) ? body.readers : []).map(reader => ({
    route: text(reader?.route, LIMITS.id), status: readerReason(reader?.status),
    last_read_at: instant(reader?.last_read_at), latest_item_at: instant(reader?.latest_item_at), last_sent_at: instant(reader?.last_sent_at),
    failed: reader?.failed ? { error: readerReason(reader.failed.error), at: instant(reader.failed.at) } : null,
  })).filter(reader => reader.route && reader.status && !readerRoutes.has(reader.route) && readerRoutes.add(reader.route)).slice(0, LIMITS.readers);
  const gates = Object.fromEntries(Object.entries(body.gates && typeof body.gates === 'object' ? body.gates : {})
    .map(([id, gate]) => [text(id, LIMITS.id), { label: text(gate?.label), steps: (Array.isArray(gate?.steps) ? gate.steps : []).map(step => text(step)).filter(Boolean).slice(0, LIMITS.steps) }])
    .filter(([id, gate]) => id && gate.label && gate.steps.length).slice(0, LIMITS.gates));
  const browser_sites = [...new Set((Array.isArray(body.browser_sites) ? body.browser_sites : []).map(vendor => text(vendor, LIMITS.id)).filter(Boolean))].slice(0, LIMITS.browser_sites);
  return { computer_id, name: text(body.name, 120) ?? 'A computer', reported_at: at, sources, readers, gates, browser_sites };
}

/** What a computer matches the sites its browsers hold against: each connect row's service, name and web address. */
export function serviceDomains(rows) {
  const services = new Map();
  for (const tool of rows?.tools ?? []) {
    const vendor = tool.invoke?.provider, domain = tool.invoke?.connects?.domain;
    if (!vendor || !domain) continue;
    const known = services.get(vendor) ?? { vendor, label: tool.label ?? vendor, domains: [] };
    if (!known.domains.includes(domain)) known.domains.push(domain);
    services.set(vendor, known);
  }
  return [...services.values()];
}

const TYPE = 'computer-sources';
const recordId = computer_id => `${TYPE}:${computer_id}`;

/** One current record per computer among the person's own records (`eeaf`: { write, read, ids }). */
export function computerSources(eeaf) {
  // Kept as a record, gates as a list (a record's field names are its own words, never a computer's ids).
  const toRecord = kept => ({ ...kept, gates: Object.entries(kept.gates).map(([id, gate]) => ({ id, ...gate })) });
  const fromRecord = record => ({ ...record, sources: record.sources ?? [], readers: record.readers ?? [], browser_sites: record.browser_sites ?? [], gates: Object.fromEntries((record.gates ?? []).map(({ id, ...gate }) => [id, { ...gate, steps: gate.steps ?? [] }])) });
  const list = () => eeaf.ids(TYPE).map(id => eeaf.read(id)).filter(Boolean).map(fromRecord).sort((left, right) => right.reported_at.localeCompare(left.reported_at));
  return {
    report(body, at) {
      const kept = keptReport(body, at);
      if (kept.computer_id.includes('/')) throw new Error('computer_id is text without "/".');
      if (!eeaf.read(recordId(kept.computer_id)) && eeaf.ids(TYPE).length >= LIMITS.computers) throw new Error(`Trillion keeps what ${LIMITS.computers} computers found. Forget one on Connections first.`);
      eeaf.write([{ id: recordId(kept.computer_id), type: TYPE, value: toRecord(kept) }], { actor: { by: 'computer', app: kept.name } });
      return { kept: true, computer_id: kept.computer_id };
    },
    list,
    forget(computer_id) {
      const id = recordId(String(computer_id ?? ''));
      if (eeaf.read(id)) eeaf.write([{ id, type: TYPE, value: null }], { actor: { by: 'person' } });
      return { forgotten: true };
    },
  };
}

/** The person store's routes for it, or null when the path is not one of them. rows() reads the Workshop rows. */
export async function handleComputerSources(owner, request, rows) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/computer-sources' && !pathname.startsWith('/computer-sources/')) return null;
  try {
    if (request.method === 'GET' && pathname === '/computer-sources') return Response.json({ computers: owner.list() });
    if (request.method === 'GET' && pathname === '/computer-sources/services') return Response.json({ services: serviceDomains(await rows()) });
    if (request.method === 'POST' && pathname === '/computer-sources') return Response.json(owner.report(await request.json()));
    if (request.method === 'POST' && pathname === '/computer-sources/forget') return Response.json(owner.forget((await request.json()).computer_id));
  } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  return Response.json({ error: 'Not found' }, { status: 404 });
}

const day = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const places = count => (count === 1 ? '1 place' : `${count} places`);

/** Connections' sections for the person's computers: one per computer, the switch it still needs first, then each source. */
export function computerSourcesSections(computers = []) {
  return computers.map(computer => {
    const waiting = computer.sources.filter(source => source.state === 'needs_switch');
    const gates = [...new Set(waiting.map(source => source.gate).filter(id => computer.gates[id]))];
    const reading = computer.sources.filter(source => source.state === 'reading').length;
    return {
      heading: `On ${computer.name}`,
      body: `Trillion looked on ${computer.name} by itself and found ${places(computer.sources.length)}${reading ? `, ${reading} already reaching your AIs` : ''}. It reads a place only when your Mac lets it, and nothing is copied from your browser. Last looked ${day(computer.reported_at)}.`,
      actions: [{ label: 'Forget this computer', tone: 'quiet', send: { path: '/work/api/computer-sources/forget', body: { computer_id: computer.computer_id }, confirm: `Forget what Trillion found on ${computer.name}? It looks again the next time Trillion opens there.` } }],
      rows: [
        ...gates.map(id => {
          const needing = waiting.filter(source => source.gate === id).map(source => source.label);
          return {
            id: `${computer.computer_id}:switch:${id}`,
            title: `Turn on ${computer.gates[id].label}`,
            detail: `${needing.join(', ')} ${needing.length === 1 ? 'needs' : 'need'} it once.`,
            status: { label: 'One switch', tone: 'attention' },
            steps: computer.gates[id].steps.map(step => ({ title: step })),
          };
        }),
        ...computer.sources.map(source => ({
          id: `${computer.computer_id}:${source.id}`,
          title: source.label,
          detail: [source.category, source.detail].filter(Boolean).join(' · ') || undefined,
          status: stateOf(source.state),
        })),
      ],
    };
  });
}

/** Which of the person's computers use each service in a browser: vendor -> [computer name]. */
export function usedInBrowserOn(computers = []) {
  const on = new Map();
  for (const computer of computers) for (const vendor of computer.browser_sites) on.set(vendor, [...(on.get(vendor) ?? []), computer.name]);
  return on;
}
