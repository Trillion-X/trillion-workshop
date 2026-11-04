// tools/see-what-is-being-worked-on/do-work/join-work-map.mjs
//
// The work map's tree from answers already read: the goals, decisions, AIs, jobs, spaces, people, automations and tool
// runs those answers hold, joined into one tree of cards and parent-to-child lines by the work map's own sources DATA
// (read-data/work-map-sources.json) and its join (read-data/join-records.mjs `joinRecords`, then `branchOf` when a card
// to start from is named). Nothing is read from the person's store, nothing is kept and nothing is sent: the caller
// gives the answers each read returned, and the tree is worked out again from them each time.
//
// Input:  { answers: { goals?, work?, spaces?, automations?, workshop? }, from? }
//           answers: what each of the work map's reads answered (goals: /work/api/decisions, work: /work/api/ai-work,
//           spaces: /work/api/spaces, automations: /work/api/workflows, workshop: /work/api/workshop); a read left
//           out adds no cards.
//           from: a card id (`<source>:<row id>`, such as "goal:g1") to show only that card and everything under it.
// Answer: { nodes: [{ id, source, kind, icon, title, detail, at?, status?, who?, root? }], lines: [{ id, from, to }],
//           counts: { <kind>: n } } (the rows themselves are not given back; each card names its source and id).
// Refuses: answers that are not an object, an answer name the work map does not read, or answers holding none of its reads.
import { branchOf, joinRecords } from '../read-data/join-records.mjs';
import map from '../read-data/work-map-sources.json' with { type: 'json' };

const READS = Object.keys(map.reads);

export function joinWorkMap({ answers, from } = {}) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error(`Give answers: an object naming what each read answered, by its name (${READS.join(', ')}).`);
  const unknown = Object.keys(answers).filter(name => !READS.includes(name));
  if (unknown.length) throw new Error(`answers names ${unknown.join(', ')}, which the work map does not read; use ${READS.join(', ')}.`);
  if (!READS.some(name => answers[name] && typeof answers[name] === 'object')) throw new Error(`answers holds none of the work map's reads; give at least one of ${READS.join(', ')} as an object.`);
  if (from !== undefined && typeof from !== 'string') throw new Error('from is a card id as text, such as "goal:g1"; leave it out for the whole tree.');
  const tree = branchOf(joinRecords({ root: map.root, sources: map.sources, answers }), from);
  const nodes = tree.nodes.map(({ row, ...card }) => card);
  const counts = {};
  for (const node of nodes) if (!node.root) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  return { nodes, lines: tree.lines, counts };
}
