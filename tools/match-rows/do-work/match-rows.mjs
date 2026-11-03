// tools/match-rows/do-work/match-rows.mjs
//
// The Workshop tool "Match rows from two places": pairs rows from two sources that describe the same thing (a bank
// line and its receipt, both sides of a transfer, a payment and its invoice, a statement line and a ledger row, a
// calendar event and a timesheet entry), the way two finance apps match transactions. Pure: it takes one request and
// returns the pairs (run as a function by tools/records-door/do-work/run-an-export.mjs). It changes no rows; the
// caller writes the pairs it accepts.
//
// Invariants:
// - The engine names no domain: which fields are compared, how and how much each counts is DATA in the request,
//   with defaults in read-data/rules.json.
// - Every pair carries its confidence and, per field, why. Pairs at or above confirm_at are matched; pairs between
//   suggest_at and confirm_at are suggested with their alternatives; nothing below suggest_at is offered.
// - A field marked required that does not agree within its tolerance rules a pair out.
// - Pairs already made (request.already) are kept and their rows are not offered again.
// - one_to_one: each row is used once, highest confidence first. many_to_one: each right row goes to its best left row,
//   and a left row may collect several (many bills paid by one payment).
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(readFileSync(new URL('../read-data/rules.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;

const pick = (row, path) => String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), row);
const round = n => Math.round(n * 1000) / 1000;

function words(text, stop) {
  return new Set(String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1 && !stop.has(w)));
}

// How well one field agrees, from 0 to 1, and why.
function compareField(field, a, b, stop) {
  if (a == null || b == null || a === '' || b === '') return { score: 0, missing: true, said: `${field.label ?? field.left} is missing on one side.` };
  if (field.kind === 'number') {
    let x = Number(a), y = Number(b);
    if (field.compare === 'opposite') y = -y;
    if (field.compare === 'absolute') { x = Math.abs(x); y = Math.abs(y); }
    const diff = Math.abs(x - y), tol = field.tolerance ?? 0;
    if (diff === 0) return { score: 1, said: `${field.label ?? field.left} is the same.` };
    if (diff <= tol) return { score: 1 - 0.5 * (diff / (tol || 1)), said: `${field.label ?? field.left} is ${round(diff)} apart, within ${tol}.` };
    return { score: 0, outside: true, said: `${field.label ?? field.left} is ${round(diff)} apart.` };
  }
  if (field.kind === 'date') {
    const days = Math.abs(Date.parse(a) - Date.parse(b)) / DAY, tol = field.tolerance ?? 0;
    if (Number.isNaN(days)) return { score: 0, missing: true, said: `${field.label ?? field.left} is not a date on one side.` };
    if (days < 1 / 24) return { score: 1, said: `${field.label ?? field.left} is the same day.` };
    if (days <= tol) return { score: 1 - 0.5 * (days / (tol || 1)), said: `${field.label ?? field.left} is ${round(days)} days apart, within ${tol}.` };
    return { score: 0, outside: true, said: `${field.label ?? field.left} is ${round(days)} days apart.` };
  }
  if (field.kind === 'words') {
    const x = words(a, stop), y = words(b, stop);
    if (!x.size || !y.size) return { score: 0, missing: true, said: `${field.label ?? field.left} has no words to compare.` };
    const shared = [...x].filter(w => y.has(w));
    const score = shared.length / Math.min(x.size, y.size);
    const outside = field.tolerance != null && score < field.tolerance;
    return { score, outside, said: shared.length ? `${field.label ?? field.left} shares ${shared.slice(0, 5).join(', ')}.` : `${field.label ?? field.left} shares no words.` };
  }
  const same = String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  return { score: same ? 1 : 0, outside: !same, said: same ? `${field.label ?? field.left} is the same.` : `${field.label ?? field.left} differs.` };
}

// The command that runs this function hands it a second argument (the person's records door); matching uses only its request.
export function matchRows(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('The request must be an object with left and right rows.');
  const rules = { ...RULES, ...(request.rules ?? {}) };
  const fields = request.fields ?? rules.fields;
  if (!Array.isArray(fields) || !fields.length) throw new Error('Name at least one field to compare.');
  const leftId = request.left_id ?? rules.id_field, rightId = request.right_id ?? rules.id_field;
  const confirmAt = request.confirm_at ?? rules.confirm_at, suggestAt = request.suggest_at ?? rules.suggest_at;
  const mode = request.mode ?? rules.mode;
  const stop = new Set(rules.ignore_words ?? []);
  const left = request.left ?? [], right = request.right ?? [];
  for (const [side, rows, idPath] of [['left', left, leftId], ['right', right, rightId]]) {
    if (!Array.isArray(rows)) throw new Error(`${side} must be a list of rows.`);
    const seen = new Set();
    rows.forEach((row, at) => {
      const id = row === null || typeof row !== 'object' ? undefined : pick(row, idPath);
      if (id == null || id === '') throw new Error(`${side} row ${at + 1} has no ${idPath}; every row needs an id (or name the id field in ${side}_id).`);
      if (seen.has(String(id))) throw new Error(`${side} has the id ${id} more than once; every row needs its own id.`);
      seen.add(String(id));
    });
  }
  const already = request.already ?? [];
  const usedLeft = new Set(already.map(p => String(p.left))), usedRight = new Set(already.map(p => String(p.right)));
  const totalWeight = fields.reduce((sum, f) => sum + (f.weight ?? 1), 0);

  const candidates = [];
  for (const l of left) {
    const lid = String(pick(l, leftId));
    if (mode === 'one_to_one' && usedLeft.has(lid)) continue;
    for (const r of right) {
      const rid = String(pick(r, rightId));
      if (usedRight.has(rid)) continue;
      let sum = 0, ruledOut = false;
      const reasons = [];
      for (const f of fields) {
        const result = compareField(f, pick(l, f.left), pick(r, f.right ?? f.left), stop);
        if (f.required && (result.outside || result.missing)) { ruledOut = true; break; }
        sum += result.score * (f.weight ?? 1);
        reasons.push({ field: f.label ?? f.left, score: round(result.score), said: result.said });
      }
      if (ruledOut) continue;
      const confidence = round(sum / totalWeight);
      if (confidence >= suggestAt) candidates.push({ left: lid, right: rid, confidence, reasons });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.left.localeCompare(b.left) || a.right.localeCompare(b.right));

  const matched = [], suggested = [];
  const takenLeft = new Set(), takenRight = new Set();
  for (const c of candidates) {
    if (takenRight.has(c.right) || (mode === 'one_to_one' && takenLeft.has(c.left))) continue;
    // A pair is only confirmed when no other unused row is nearly as good for either side.
    const rival = candidates.find(o => o !== c && !takenRight.has(o.right) && !(mode === 'one_to_one' && takenLeft.has(o.left))
      && (o.left === c.left || o.right === c.right) && c.confidence - o.confidence < rules.clear_lead);
    const sure = c.confidence >= confirmAt && !(rival && mode === 'one_to_one');
    takenRight.add(c.right); takenLeft.add(c.left);
    if (sure) matched.push(c);
    else suggested.push({ ...c, alternatives: candidates.filter(o => o !== c && (o.left === c.left || o.right === c.right)).slice(0, rules.alternatives).map(({ left, right, confidence }) => ({ left, right, confidence })) });
  }
  const pairedLeft = new Set([...matched, ...suggested].map(p => p.left)), pairedRight = new Set([...matched, ...suggested].map(p => p.right));
  return {
    matched, suggested, kept: already,
    unmatched_left: left.map(l => String(pick(l, leftId))).filter(id => !pairedLeft.has(id) && !usedLeft.has(id)),
    unmatched_right: right.map(r => String(pick(r, rightId))).filter(id => !pairedRight.has(id) && !usedRight.has(id)),
  };
}
