// computer/meeting-notes.mjs
//
// Purpose
//   Turns what one listening moment heard (computer/listen.mjs: lines with their speakers) into meeting notes, on this
//   computer: a model served here (computer/local-models.mjs, job `row.job`) is asked for the fields the person's DATA
//   names (computer-sources.json listen.notes.fields: a summary, decisions, actions, anything else is one more row), and
//   what it answers is kept with the moment's sound and words as one more result (kind row.result_kind).
//
// Non-negotiable invariants
//   1. The words never leave this computer to make notes: the model asked is this computer's own. Nothing answering is
//      not a failure of the listening; the moment simply has no notes (null) and says why in the log.
//   2. Every fact in a note names the lines it came from (`from`, numbers of the lines the model was shown). Lines the
//      model never saw are dropped from it; an item left with no line it can stand on is not kept as a note (it is
//      counted in `unsupported`). A valid reference proves where to check the generated note, not that the model's
//      claim follows from those words. These are generated notes, never verified facts or automatically executed actions.
//   3. Only lines the person's keep rules keep are shown to the model (`keeps`, listen.rules through listen.mjs `decide`,
//      the same test the sent turns pass), so what was left out of the record ("off the record") is not summarised back into it.
//   4. Fields, prompts, limits and words are DATA (row.notes); this file names no field and no speaker.
//   5. A template (row.notes.templates) is DATA: sections with a heading and a description become the fields asked for, and the
//      heading cap grows with how much was said (heading_cap), so a short chat is not asked for twelve headings. A template
//      that does not exist makes no notes (said in the log); it is never swapped for another. Notes are their own result
//      beside the moment, never written into anything the person typed, so asking again with another template cannot overwrite it.
//   7. Action items in the notes can become task PROPOSALS (row.notes.propose_tasks, taskProposalsFrom): the person approves or rejects each one
//      through the account's own tool; nothing here makes a task, and an item whose due date was not said as YYYY-MM-DD carries none.
//   6. Whether the meeting ended (row.notes.ended) is a separate small question about the last words only, asked of the same
//      local job as the notes: the model answers one of two fixed words in a JSON object, anything else is null (unknown), and it
//      only labels the notes (`ended`); it never withholds them.
//
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const wordsIn = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const slug = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The fields a template asks for, given how many words were said: { fields, template, dropped }, or null when the
 * template does not exist. No template: the row's own fields. A template with `fields_from` uses that list of the row.
 * Sections beyond heading_cap (base + one per `per_words` said, at most `most`) are dropped, counted in `dropped`.
 */
export function templateFields(notes, templateId, words = 0) {
  if (!templateId) return { fields: notes.fields, template: null, dropped: 0 };
  const template = (notes.templates ?? []).find(row => row.id === templateId);
  if (!template) return null;
  if (template.fields_from) return { fields: notes[template.fields_from] ?? [], template: template.id, dropped: 0 };
  const cap = notes.heading_cap ?? { base: 3, per_words: 600, most: 12 };
  const most = Math.min(cap.most, cap.base + Math.floor(words / cap.per_words));
  const seen = new Set();
  const sections = (template.sections ?? []).filter(section => slug(section.heading) && !seen.has(slug(section.heading)) && seen.add(slug(section.heading)));
  const fields = sections.slice(0, most).map(section => ({ id: slug(section.heading), shape: section.shape ?? 'list', says: section.description || section.heading }));
  return { fields, template: template.id, dropped: sections.length - fields.length };
}

/** The lines a model may be shown (`keeps(line)`: the person's keep rules), numbered from 1 in the order said: [{ n, speaker, text, source_id }]. */
export function shownLines(lines, keeps = () => true) {
  return lines.filter(keeps)
    .map((line, index) => ({ n: index + 1, speaker: line.speaker, text: line.text, source_id: line.source_id }));
}

/** The question for the model: the row's instructions, one line per field, and the numbered lines. */
export function questionOf(notes, shown) {
  const fields = notes.fields.map(field => fill(notes.words.field, { id: field.id, shape: notes.words.shapes[field.shape] ?? field.shape, says: field.says })).join('\n');
  const said = shown.map(line => fill(notes.words.line, { n: line.n, speaker: line.speaker, text: line.text })).join('\n');
  return [{ role: 'system', content: notes.words.system }, { role: 'user', content: fill(notes.words.ask, { fields, lines: said }) }];
}

const itemOf = (value, shape, most) => {
  const item = typeof value === 'string' ? { text: value } : value;
  const text = String(item?.text ?? '').trim();
  const from = Array.isArray(item?.from) ? [...new Set(item.from.map(Number).filter(Number.isInteger))] : [];
  return { shape, text: text.slice(0, most), from, extra: Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => !['text', 'from', 'sources'].includes(key) && typeof item[key] === 'string' && item[key].trim())) };
};

/**
 * The model's answer ({ <field id>: text | [{ text, from, ...}] }) as notes: each item kept only when it names at least
 * one line that was shown; `from` is cut to those lines and given back as their source_ids too (`sources`).
 * Returns { fields: { <id>: [{ text, from, sources, ...extra }] }, unsupported }.
 */
export function notesFrom(answer, notes, shown) {
  const known = new Map(shown.map(line => [line.n, line]));
  const kept = {}; let unsupported = 0;
  for (const field of notes.fields) {
    const raw = answer?.[field.id];
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    kept[field.id] = [];
    for (const value of values.slice(0, notes.most_items)) {
      const item = itemOf(value, field.shape, notes.most_characters);
      const from = item.from.filter(n => known.has(n));
      if (!item.text) continue;
      if (!from.length) { unsupported += 1; continue; }
      kept[field.id].push({ text: item.text, from, sources: from.map(n => known.get(n).source_id), ...item.extra });
    }
  }
  return { fields: kept, unsupported };
}

/**
 * Whether the meeting ended, from its last `last_words` kept words: true, false, or null (unknown: too little said, no
 * model answered, or an answer that is neither fixed word). `ended` is row.notes.ended.
 */
export async function meetingEnded({ lines, keeps = () => true, ended, ask, log = () => {} }) {
  if (!ended || ended.on === false) return null;
  const shown = shownLines(lines, keeps);
  const words = shown.map(line => line.text).join(' ').trim().split(/\s+/).filter(Boolean);
  if (words.join(' ').length < (ended.min_characters ?? 0)) return null;
  const reply = await ask({ job: ended.job, messages: [
    { role: 'system', content: ended.words.system },
    { role: 'user', content: fill(ended.words.ask, { words: words.slice(-ended.last_words).join(' ') }) },
  ], temperature: 0, max_tokens: ended.max_tokens });
  if (reply?.error) { log(fill(ended.words.unanswered, { reason: reply.error })); return null; }
  let said = '';
  try { said = String(JSON.parse(reply?.choices?.[0]?.message?.content ?? '')?.answer ?? '').trim().toLowerCase(); } catch { return null; }
  if (said === ended.answers.ended) return true;
  return said === ended.answers.continuing ? false : null;
}

/**
 * Meeting notes for one moment, or null (too little said, notes off, no model answered, an answer that is not JSON).
 * `lines` are [{ text, speaker, source_id }]; `keeps(line)` is the person's keep rules; `ask(input)` is askLocal bound to this computer's settings.
 * `template` is a template id of row.notes.templates (none: the row's own fields).
 * Returns { kind, value: { fields, unsupported, lines_shown, model, template, ended }, produced_by }.
 */
export async function meetingNotes({ lines, keeps = () => true, notes, ask, template = null, log = () => {} }) {
  if (!notes || notes.on === false) return null;
  const shown = shownLines(lines, keeps).slice(-notes.most_lines);
  const said = shown.reduce((total, line) => total + wordsIn(line.text), 0);
  if (said < notes.min_words) return null;
  const chosen = templateFields(notes, template, said);
  if (!chosen) { log(fill(notes.words.unknown_template, { template })); return null; }
  const asked = { ...notes, fields: chosen.fields };
  const reply = await ask({ job: notes.job, messages: questionOf(asked, shown), temperature: 0, max_tokens: notes.most_tokens });
  if (reply?.error) { log(fill(notes.words.unanswered, { reason: reply.error })); return null; }
  let answer;
  try { answer = JSON.parse(reply?.choices?.[0]?.message?.content ?? ''); } catch { log(notes.words.not_json); return null; }
  const { fields, unsupported } = notesFrom(answer, asked, shown);
  const ended = await meetingEnded({ lines, keeps, ended: notes.ended, ask, log }).catch(() => null);
  return { kind: notes.result_kind, value: { fields, unsupported, lines_shown: shown.length, model: reply.model ?? null, template: chosen.template, dropped_sections: chosen.dropped, ended }, produced_by: notes.produced_by };
}

/**
 * The proposals for the person to review that a note's action items make: { source_id, proposed_by, items: [{ title, due?, evidence? }] }, or
 * null when proposing is off or the notes have no action item. `notes` is row.notes, `made` a meetingNotes() result, `sourceId` names the moment.
 * The fields read are notes.propose_tasks.fields (a template may call its action list something else); at most `most` items.
 */
export function taskProposalsFrom(made, notes, sourceId) {
  const rule = notes?.propose_tasks;
  if (!rule || rule.on === false || !made?.value?.fields) return null;
  const found = (rule.fields ?? []).flatMap(field => made.value.fields[field] ?? []).slice(0, rule.most ?? 20);
  if (!found.length) return null;
  const items = found.map(item => ({
    title: item.text,
    ...(typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? { due: item.due } : {}),
    ...(typeof item.owner === 'string' && item.owner.trim() ? { evidence: `${item.owner.trim()}: ${item.text}` } : {}),
  }));
  return { source_id: sourceId, proposed_by: rule.proposed_by, items };
}
