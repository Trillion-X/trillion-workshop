// src/funnel-read.mjs
//
// PURPOSE
//   One funnel from the person's Funnels folder read as its stages with live measures: the funnel file (a graph with
//   its offer nodes), the facts it names (inline, or a file of records), the person's commercial events that name the
//   graph's id, the counted visits and clicks its `measures.interactions` rows ask for (each row a stage, a kind of
//   interaction and the facts it must have, read from the interaction counts, src/interactions.mjs funnelFacts), and
//   their price experiments on it (a settled one's winner is the price its node shows). The Funnels
//   screen (src/workspace/funnels-screen.tsx) and tool:read-a-funnel both read a funnel here, each with its own readers.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the readers handed in reach the person's files and events; nothing here names a stage, an event or a field
//      (the shared resolver, parts/funnel-offer-graph funnelStages, reads those from the funnel's own DATA).
//   2. A price experiment joins a funnel only when it names the funnel (funnel_id) or one of its nodes (node_ref).
//   3. A file that cannot be drawn answers its problem in words; a reader that fails throws.
//
import { funnelStages } from 'trillion-workshop/tools/funnels-screen/read-data/stage-projection.ts';

export const FUNNELS_FOLDER = '/Funnels';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A list of records, whether the file holds the list itself, or { records | facts | items: [...] }; a kept record's
// payload stands for it.
export const recordsIn = value => {
  const found = Array.isArray(value) ? value : ['records', 'facts', 'items'].map(key => value?.[key]).find(Array.isArray) ?? [];
  return found.map(item => (object(item) && 'payload' in item ? item.payload : item));
};

/**
 * One funnel, read through `readers`: { bytes(name) → text | null, events(funnelId) → events, experiments() → price
 * experiments, interactions?(rows, stageField) → facts }. → { path, funnel } or { path, funnel: null, problem }.
 */
export async function loadFunnel(path, readers) {
  const raw = await readers.bytes(path);
  if (raw === null || raw === undefined) return { path, funnel: null, problem: `There is no funnel file ${path}.` };
  let row;
  try { row = JSON.parse(raw); } catch { return { path, funnel: null, problem: 'This file is not a funnel graph (it is not JSON).' }; }
  if (!object(row)) return { path, funnel: null, problem: 'This file has no funnel graph with an entry stage.' };
  const measures = object(row.measures) ? row.measures : {};
  let facts = recordsIn(measures.facts ?? []);
  if (typeof measures.facts_file === 'string' && measures.facts_file) {
    const file = await readers.bytes(measures.facts_file);
    if (file !== null && file !== undefined) facts = [...facts, ...recordsIn(JSON.parse(file))];
  }
  if (Array.isArray(measures.interactions) && measures.interactions.length && readers.interactions) {
    facts = [...facts, ...(await readers.interactions(measures.interactions, typeof measures.stage_field === 'string' ? measures.stage_field : 'stage'))];
  }
  let experiments = Array.isArray(row.experiments) ? row.experiments : [];
  if (typeof row.id === 'string' && row.id) {
    facts = [...facts, ...(await readers.events(row.id))];
    const nodes = new Set((Array.isArray(row.nodes) ? row.nodes : []).map(node => node?.id).filter(Boolean));
    const own = (await readers.experiments()).filter(experiment => experiment.funnel_id === row.id || nodes.has(experiment.node_ref));
    experiments = [...experiments, ...own];
  }
  const funnel = funnelStages({ ...row, experiments }, facts);
  return funnel ? { path, funnel } : { path, funnel: null, problem: 'This file has no funnel graph with an entry stage.' };
}

/** tool:read-a-funnel: with `name`, that funnel's stages; without, every funnel in the folder with its entry and end counts. */
export async function readFunnel({ name } = {}, readers) {
  const pathOf = text => (text.startsWith('/') ? text : `${FUNNELS_FOLDER}/${text}${text.endsWith('.json') ? '' : '.json'}`);
  if (typeof name === 'string' && name.trim()) {
    const one = await loadFunnel(pathOf(name.trim()), readers);
    if (!one.funnel) throw new Error(one.problem);
    return one;
  }
  const names = (await readers.list(FUNNELS_FOLDER)).filter(item => item.endsWith('.json'));
  const loaded = await Promise.all(names.map(path => loadFunnel(path, readers)));
  return {
    funnels: loaded.map(({ path, funnel, problem }) => ({
      path, title: funnel?.title ?? path.split('/').pop(), stages: funnel?.stages.length ?? 0,
      entered: funnel?.stages[0]?.measures.visits ?? 0, reached_the_end: funnel?.stages.at(-1)?.measures.conversions ?? 0,
      ...(problem ? { problem } : {}),
    })),
  };
}
