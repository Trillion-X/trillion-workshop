// tools/workflows/read-data/workflow-run-find.mjs
//
// The workflows for this moment, as the door's find (the same ranking as wf find on the Mac): the words are scored over each
// workflow's name, job and steps (BM25), and with kinds the chooser (choose-the-workflows-that-fire) picks by the kinds of
// moment each workflow waits for, the words breaking ties. Candidates are the shipped recipes (recipes/*.json) and the
// person's own workflow rows, which the caller reads from wherever the person keeps them and passes as own; an own row wins
// over a shipped one of the same id. Reaches no database and no door: nothing is kept.
//
// The answer is small: at most MATCH_LIMIT matches, each with a short job and the exact input a start takes (next).
import { publicRecipes } from './public-recipes.mjs';
import { chooseTheWorkflowsThatFire } from './choose-the-workflows-that-fire.mjs';
import { FIRES_WHEN } from './fires-when.mjs';

const MATCH_LIMIT = 8;
const JOB_CHARS = 200;
const COMMON = ['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'its', 'be', 'by', 'with', 'this', 'that', 'from', 'as', 'at',
  'are', 'was', 'so', 'do', 'my', 'me', 'i', 'we', 'our', 'his', 'her', 'their', 'they', 'them', 'you', 'your', 'what', 'when', 'which', 'who', 'how', 'not', 'no', 'one', 'each', 'every'];

function stem(word) {
  for (const end of ['ings', 'ing', 'ers', 'ies', 'ied', 'ed', 'es', 'er', 's']) {
    if (word.length > end.length + 3 && word.endsWith(end)) return word.slice(0, -end.length);
  }
  return word;
}

function wordsOf(text) {
  return String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1 && !COMMON.includes(word)).map(stem);
}

// Every rule of a condition tree that reads the field `kinds`, as the kinds it names.
function kindsIn(node, found = new Set()) {
  if (node?.kind === 'rule' && node.field === 'kinds') for (const value of node.params?.values ?? []) if (typeof value === 'string') found.add(value);
  for (const child of node?.rules ?? []) kindsIn(child, found);
  return found;
}

function conditionsOf(value) {
  const raw = value?.[FIRES_WHEN.field];
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(list) ? list.filter(item => !FIRES_WHEN.off_states.includes(item?.state)) : [];
}

function entryOf(id, value, own) {
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const kinds = new Set();
  for (const item of conditionsOf(value)) kindsIn(item.condition?.tree, kinds);
  const words = [value.label ?? value.title, value.job, ...steps.map(step => `${step.title ?? ''} ${step.do ?? ''}`)].join(' ');
  return { id, label: value.label ?? value.title ?? id, job: value.job ?? '', kinds: [...kinds].sort(), words, own };
}

// Shipped recipes first, then the person's own rows over them (by id).
function candidates(ownRows) {
  const byId = new Map();
  for (const payload of publicRecipes()) if (payload.id && !byId.has(payload.id)) byId.set(payload.id, entryOf(payload.id, payload, false));
  for (const row of ownRows) {
    const value = row?.value ?? {};
    if (typeof row?.id !== 'string' || !row.id) throw new Error('each own row needs its id.');
    byId.set(row.id, entryOf(row.id, value, true));
  }
  return [...byId.values()];
}

// BM25 over each workflow's name and job (counted twice) and its steps' words, as wf find scores them.
function wordScores(entries, query) {
  const docs = entries.map(entry => {
    const head = `${entry.id.replace(/[-:]/g, ' ')} ${entry.label} ${entry.job}`;
    return { id: entry.id, terms: [...wordsOf(head), ...wordsOf(head), ...wordsOf(entry.words)] };
  });
  const n = Math.max(docs.length, 1);
  const average = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / n;
  const wanted = [...new Set(query)];
  const holding = new Map(wanted.map(term => [term, docs.filter(doc => doc.terms.includes(term)).length]));
  const scores = new Map();
  for (const doc of docs) {
    const score = wanted.reduce((sum, term) => {
      const tf = doc.terms.filter(t => t === term).length;
      if (tf === 0) return sum;
      const df = holding.get(term);
      const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
      return sum + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.terms.length / average));
    }, 0);
    if (score > 0) scores.set(doc.id, score);
  }
  return scores;
}

function shortJob(text) {
  return [...text].slice(0, JOB_CHARS).join('');
}

/** input: { words?: string, kinds?: string[], own?: [{ id, value }] }. Returns { matches, unknown_kinds, chooser }. */
export async function workflowRunFind(input = {}) {
  const words = typeof input.words === 'string' ? input.words : '';
  const kinds = Array.isArray(input.kinds) ? input.kinds.map(kind => String(kind).trim()).filter(Boolean) : [];
  const own = Array.isArray(input.own) ? input.own : [];
  if (!words.trim() && !kinds.length) throw new Error('give words (the job in a few words) or kinds (the kinds of moment), or both.');
  const entries = candidates(own);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const vocabulary = new Set(entries.flatMap(entry => entry.kinds));
  const unknownKinds = kinds.filter(kind => !vocabulary.has(kind));
  const wordsScored = wordScores(entries, wordsOf(words));
  const ranked = new Map();
  let chooser = 'not asked: no kinds given';
  if (kinds.length) {
    try {
      const answer = await chooseTheWorkflowsThatFire({ parts: [{ words, kinds }], own });
      for (const pick of answer.chosen ?? []) {
        if (!ranked.has(pick.workflow)) ranked.set(pick.workflow, { kinds: pick.score ?? 0 });
      }
      chooser = `answered: ${ranked.size} chosen`;
    } catch (error) {
      chooser = `failed: ${error.message}`;
    }
  }
  const scored = entries.map(entry => {
    const kindScore = ranked.get(entry.id)?.kinds;
    const wordScore = wordsScored.get(entry.id) ?? 0;
    return { entry, kindScore, wordScore, total: (kindScore ?? 0) + wordScore };
  }).filter(item => item.kindScore !== undefined || item.wordScore > 0);
  scored.sort((a, b) => (b.kindScore !== undefined) - (a.kindScore !== undefined) || b.total - a.total || (a.entry.id < b.entry.id ? -1 : 1));
  const matches = scored.slice(0, MATCH_LIMIT).map(({ entry, kindScore, wordScore, total }) => ({
    workflow: entry.id,
    label: entry.label,
    job: shortJob(entry.job),
    kinds: entry.kinds,
    own: entry.own,
    why: kindScore !== undefined ? `kinds ${kindScore.toFixed(1)} + words ${wordScore.toFixed(1)}` : `words ${total.toFixed(1)}`,
    next: { tool: 'wf start WORKFLOW_ID (door op workflow:start is not built yet)', input: { workflow: byId.get(entry.id).id, input: { request: words || kinds.join(', ') } } },
  }));
  return { matches, unknown_kinds: unknownKinds, chooser };
}
