// src/voice-guesses.mjs
//
// PURPOSE
//   A best guess, for each voice nobody has named, of which of the person's people it is, from evidence the account
//   already holds, so the Waiting on you screen opens with each voice's likeliest person chosen and the reason beside it
//   instead of fifty empty boxes: what the listener itself thought ("Unsure (Morgan?)"), a person already chosen for the
//   same guess in another session, the person's calendar at that moment, and the title and file names of the recording
//   the voice was heard in, and, weakest of all, a name someone said in the same conversation (that person is in the room,
//   but probably as another voice). It also puts away what is not worth asking: the person's own voice, and a recording playing
//   in another language than they speak, and it folds voices guessed to be the same person into one row naming each.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a person, a list, a vendor, a language or a sentence shown. Every rule, weight, limit,
//      script and sentence is DATA (src/waiting-on-you.json `sources.voices.guess`), and the people are handed in as rows
//      (the rows of every list that holds people), never looked up by a list's name.
//   2. A guess is only a suggestion: it never names a voice. It only says which row, with the words that show why (each
//      source's `why`, filled with the person's name and the evidence found, which is cut to `evidence_chars`).
//   3. A person is matched on whole words, ignoring case and accents: by their whole title (full weight) or by their first
//      word when it has at least `first_word_letters` letters (`first_word_share` of the weight). Part of a word never
//      matches: a longer word that contains a name is not that name.
//   4. The person's own name is no evidence of whose voice it is on a calendar or a recording title, since they are in
//      every one: such a match is dropped, and only the sources in `owner_evidence` can say a voice is theirs, which
//      leaves it out (`left_out.own`).
//   5. A voice with no voice evidence (invariant 9), whose words are mostly in another script than the person's own words,
//      is a recording playing, not a person to name: it is left out (`left_out.playback`). Moment evidence never keeps it
//      in, since a recording's title says nothing about the film playing in it.
//   6. Voices guessed to be the same row are one row (the newest with a clip first) carrying the others in `also`, only when
//      the guess rests on voice evidence; a voice with no evidence is never folded into another and comes last. Order: best
//      score first, then newest.
//   9. Each source declares a `scope` in DATA: `voice` evidence is about this voice itself (the listener's guess, a name
//      chosen before for the same guess); `moment` evidence is about the recording or time it was heard in (title, file
//      name, calendar, a name said nearby) and is the same for every voice of that moment. Moment = same app with an
//      overlapping since..until, or the same clip. A suggestion is `sure` (preselectable) when it rests on voice evidence,
//      or when it rests on moment evidence and no other listed voice of the same moment carries the same row as its best
//      guess. An unsure suggestion is still offered first, with its why, but never chosen for the person.
//  10. A file name matches on the file's own base name only: no folders, no extension.
//   7. Every read is handed in (`read`) and bounded by the caller; a source that cannot be read leaves its evidence out
//      and never stops the others.
//   8. A name said in the same conversation (source `said`) counts for a person when a message in the voice's window
//      (since..until widened by `said.minutes`, at most `said.reads` messages, of the voice's own app) that this voice did
//      not speak holds the name (invariant 3's matcher). A person who speaks in that window under their own name is not
//      counted, and the owner never is (invariant 4). Its weight is the lowest, so it never outranks a listener guess, and a
//      `said` is moment evidence (invariant 9): two voices in one conversation that both hear the same name are not
//      therefore the same person.
//
// Key concepts
//   voice    a row of messages.unnamedSpeakers with a clip attached: { id, app, speaker, since, until, last_at, turns, clip?, conversation_id?, ... }
//   people   [{ id, list_id, row_type, title }]
//   read     { owner: string, ownerWords(): string[], calendar({ from, to }): { items }, title(identity), names(identity): string[],
//              earlier({ app, speaker }): the `record:<row type>:<id>` chosen for that same label before, or null,
//              said({ conversation_id, since, until, limit }): [{ app, speaker, text, at }], at most `limit` messages }
//   answer   { voices: rows with suggestions [{ id?, list_id?, title, why, sure }], why, also?; left_out: { own, playback } }
//

const fold = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const tokens = text => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (text, pattern) => (String(text).match(pattern) ?? []).length;
const recordOf = person => `record:${person.row_type}:${person.id}`;
/** A read that fails (or answers nothing) is `otherwise`, so one source never stops the others (invariant 7). */
const ask = async (work, otherwise) => { try { return (await work()) ?? otherwise; } catch { return otherwise; } };

/** The script most of the letters in `texts` are in, or null when there are fewer than `min` letters; `share` is how much of them. */
function scriptOf(texts, { scripts, min_letters: min }) {
  const joined = texts.join(' ');
  const letters = count(joined, /\p{L}/gu);
  if (letters < min) return null;
  const per = Object.entries(scripts).map(([name, source]) => [name, count(joined, new RegExp(source, 'gu'))]).sort((a, b) => b[1] - a[1]);
  return per[0]?.[1] ? { name: per[0][0], letters, of: Object.fromEntries(per) } : null;
}

/** Looks a text up among the people: Map(person -> share of the weight it earns), by whole title or by first word. */
function matcher(people, rules) {
  const byFirst = new Map();
  for (const person of people) {
    const words = tokens(person.title);
    if (!words.length || words[0].length < rules.first_word_letters) continue;
    byFirst.set(words[0], [...(byFirst.get(words[0]) ?? []), { person, whole: ` ${words.join(' ')} ` }]);
  }
  return text => {
    const found = tokens(text), joined = ` ${found.join(' ')} `, hits = new Map();
    for (const word of new Set(found)) for (const { person, whole } of byFirst.get(word) ?? []) hits.set(person, joined.includes(whole) ? 1 : rules.first_word_share);
    return hits;
  };
}

/**
 * Guesses for `voices`. `pattern` is the label of a voice the listener guessed ("Unsure (Morgan?)", its `guess` group).
 * Answers { voices, left_out } as the header says.
 */
export async function guessVoices({ voices, rules, pattern, people, read }) {
  const match = matcher(people, rules);
  const byRecord = new Map(people.map(person => [recordOf(person), person]));
  const split = new RegExp(rules.separators.map(escaped).join('|'));
  const guessLabel = new RegExp(pattern);
  const owner = tokens(read.owner ?? '').join(' ');
  const isOwner = person => owner !== '' && tokens(person.title).join(' ') === owner;
  const ownerScript = scriptOf(await ask(() => read.ownerWords?.(), []), rules.playback);
  const all = voices.flatMap(voice => [Date.parse(voice.since), Date.parse(voice.until)]).filter(Number.isFinite);
  const span = all.length ? { from: new Date(Math.min(...all) - rules.calendar.minutes * 60_000).toISOString(), to: new Date(Math.max(...all) + rules.calendar.minutes * 60_000).toISOString() } : null;
  const items = span ? (await ask(() => read.calendar?.(span), { items: [] })).items ?? [] : [];
  const left_out = { own: 0, playback: 0 };
  const guessed = [];
  for (const voice of voices) {
    const evidence = new Map();
    const add = (hits, source, text) => {
      for (const [person, share] of hits) {
        if (isOwner(person) && !rules.owner_evidence.includes(source)) continue;
        const per = evidence.get(person) ?? new Map();
        if (!(per.get(source)?.share >= share)) per.set(source, { share, text });
        evidence.set(person, per);
      }
    };
    const unmatched = [];
    for (const candidate of (guessLabel.exec(voice.speaker)?.groups?.guess ?? '').split(split).map(item => item.trim()).filter(Boolean)) {
      const hits = match(candidate);
      if (hits.size) add(hits, 'listener', candidate); else unmatched.push(candidate);
    }
    const before = await ask(() => read.earlier?.({ app: voice.app, speaker: voice.speaker }), null);
    if (byRecord.has(before)) add(new Map([[byRecord.get(before), 1]]), 'elsewhere', byRecord.get(before).title);
    const [from, to] = [Date.parse(voice.since) - rules.calendar.minutes * 60_000, Date.parse(voice.until) + rules.calendar.minutes * 60_000];
    const near = items.filter(item => !(rules.calendar.skip_all_day && item.all_day) && Date.parse(item.starts_at) <= to && Date.parse(item.ends_at ?? item.starts_at) >= from)
      .sort((a, b) => Math.abs(Date.parse(a.starts_at) - Date.parse(voice.since)) - Math.abs(Date.parse(b.starts_at) - Date.parse(voice.since))).slice(0, rules.calendar.reads);
    for (const item of near) add(match(item.title), 'calendar', item.title);
    if (voice.clip) {
      const title = await ask(() => read.title?.(voice.clip), null);
      if (title) add(match(title), 'title', title);
      // Its own base name only (invariant 10): a folder or extension naming a person is no evidence of who spoke.
      for (const name of await ask(() => read.names?.(voice.clip), [])) {
        const base = String(name).split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
        add(match(base), 'file_name', base);
      }
    }
    // A name said in the same conversation (invariant 8): by anyone but this voice, and not of someone already speaking in it.
    const [saidFrom, saidTo] = [Date.parse(voice.since) - rules.said.minutes * 60_000, Date.parse(voice.until) + rules.said.minutes * 60_000];
    if (voice.conversation_id && Number.isFinite(saidFrom) && Number.isFinite(saidTo)) {
      const around = (await ask(() => read.said?.({ conversation_id: voice.conversation_id, since: new Date(saidFrom).toISOString(), until: new Date(saidTo).toISOString(), limit: rules.said.reads }), []))
        .filter(message => message.app === voice.app).slice(0, rules.said.reads);
      const speaking = new Set(around.filter(message => !guessLabel.test(message.speaker)).flatMap(message => [...match(message.speaker).keys()]));
      for (const message of around) {
        if (message.speaker === voice.speaker) continue;
        add(new Map([...match(message.text)].filter(([person]) => !speaking.has(person))), 'said', message.text);
      }
    }
    const entries = [...evidence].map(([person, per]) => {
      const used = [...per].map(([source, { share, text }]) => ({ source, weight: rules.sources[source].weight * share, text })).sort((a, b) => b.weight - a.weight);
      return { person, score: used.reduce((sum, item) => sum + item.weight, 0), used };
    });
    for (const title of unmatched) entries.push({ person: null, title, score: rules.sources.listener.weight, used: [{ source: 'listener', weight: rules.sources.listener.weight, text: title }] });
    entries.sort((a, b) => b.score - a.score || String(a.person?.title ?? a.title).localeCompare(String(b.person?.title ?? b.title)));
    if (entries[0]?.person && isOwner(entries[0].person)) { left_out.own += 1; continue; }
    const ofVoice = entry => entry.used.some(item => rules.sources[item.source].scope === 'voice');
    if (!entries.some(ofVoice) && ownerScript) {
      const heard = scriptOf([voice.clear_words || voice.last_words || ''], rules.playback);
      if (heard && 1 - (heard.of[ownerScript.name] ?? 0) / heard.letters >= rules.playback.other_share) { left_out.playback += 1; continue; }
    }
    const suggestions = entries.slice(0, rules.most_suggestions).map(entry => {
      const { person, title, used } = entry;
      const name = person?.title ?? title;
      const why = used.map(item => fill(rules.sources[item.source].why, { name, text: String(item.text).slice(0, rules.evidence_chars) })).join(rules.join);
      return { ...(person ? { id: person.id, list_id: person.list_id } : {}), title: name, why, voiced: ofVoice(entry) };
    });
    guessed.push({ voice, suggestions, score: entries[0]?.score ?? 0, top: entries[0] && ofVoice(entries[0]) ? entries[0].person : null, best: entries[0]?.person ?? null });
  }
  // `sure` (invariant 9): voice evidence, or moment evidence that no other voice of the same moment shares as its best guess.
  const sameMoment = (a, b) => (a.clip && a.clip === b.clip)
    || (a.app === b.app && Date.parse(a.since) <= Date.parse(b.until) && Date.parse(b.since) <= Date.parse(a.until));
  for (const item of guessed) {
    for (const suggestion of item.suggestions) {
      const shared = !suggestion.voiced && suggestion.id !== undefined && guessed.some(other => other !== item && other.best
        && other.best.id === suggestion.id && other.best.list_id === suggestion.list_id && sameMoment(item.voice, other.voice));
      suggestion.sure = suggestion.voiced || (suggestion.id !== undefined && !shared);
      delete suggestion.voiced;
    }
  }
  const newest = (a, b) => String(b.last_at).localeCompare(String(a.last_at));
  const groups = new Map();
  const rows = [];
  for (const item of guessed) {
    if (!item.top) { rows.push([item]); continue; }
    const held = groups.get(item.top);
    if (held) held.push(item); else { groups.set(item.top, [item]); rows.push(groups.get(item.top)); }
  }
  const made = rows.map(members => {
    const ordered = [...members].sort((a, b) => Number(Boolean(b.voice.clip)) - Number(Boolean(a.voice.clip)) || newest(a.voice, b.voice));
    const [first, ...rest] = ordered;
    const row = { ...first.voice, suggestions: first.suggestions, ...(first.suggestions[0]?.why ? { why: first.suggestions[0].why } : {}) };
    if (rest.length) {
      row.also = rest.map(({ voice }) => ({ id: voice.id, app: voice.app, speaker: voice.speaker, since: voice.since, until: voice.until, turns: voice.turns, ...(voice.voice === undefined ? {} : { voice: voice.voice }) }));
      row.turns = ordered.reduce((sum, { voice }) => sum + (voice.turns ?? 0), 0);
    }
    return { row, score: Math.max(...members.map(member => member.score)) };
  });
  made.sort((a, b) => b.score - a.score || newest(a.row, b.row));
  return { voices: made.map(item => item.row), left_out };
}
