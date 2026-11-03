// tools/field-values/do-work/precedence.mjs
//
// Purpose: the one place that says which source's value a field keeps. Every tool of this folder asks it: setting
// fields by rules asks whether a rule may write over what a field holds, filling a column asks it through the offers it
// answers, and settling offers asks it for the winner of each field.
//
// Non-Negotiable Invariants:
//   1. The order of source kinds, how ties inside a kind break, what an unknown source does, the confidence floors and
//      the confidence words are DATA (read-data/value-sources.json, or the request's own `precedence` of that shape);
//      no kind is named in code.
//   2. A stronger kind is never replaced by a weaker one, whatever their times or confidences.
//   3. An offer below its kind's confidence floor never wins; it is set aside and said.
//   4. Every comparison is total and deterministic: the last tie-break is the order the offers were handed in.
import defaultPrecedence from '../read-data/value-sources.json' with { type: 'json' };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };

/** The precedence a request uses: its own, checked, or the default rows. */
export function precedenceOf(request) {
  const policy = request.precedence ?? defaultPrecedence;
  need(isObject(policy) && Array.isArray(policy.kinds) && policy.kinds.length > 0,
    'precedence must be { kinds: [{ id, says, confidence_at_least? }, ...] strongest first, same_kind_order, unknown_source, confidence_words }, the shape of read-data/value-sources.json.');
  need(policy.kinds.every(kind => isObject(kind) && typeof kind.id === 'string' && kind.id.length > 0
    && (kind.confidence_at_least === undefined || (typeof kind.confidence_at_least === 'number' && kind.confidence_at_least >= 0 && kind.confidence_at_least <= 1))),
  'every precedence kind needs an id, and a confidence_at_least, when given, between 0 and 1.');
  need(new Set(policy.kinds.map(kind => kind.id)).size === policy.kinds.length, 'two precedence kinds share an id; each kind is listed once.');
  const orders = (policy.same_kind_orders ?? defaultPrecedence.same_kind_orders).map(row => row.id);
  const sameKindOrder = policy.same_kind_order ?? [];
  need(Array.isArray(sameKindOrder) && sameKindOrder.every(id => orders.includes(id)), `same_kind_order lists ways to break a tie inside one kind: ${orders.join(', ')}.`);
  const unknowns = (policy.unknown_source_choices ?? defaultPrecedence.unknown_source_choices).map(row => row.id);
  need(unknowns.includes(policy.unknown_source), `unknown_source is one of ${unknowns.join(', ')}.`);
  const words = policy.confidence_words ?? {};
  need(isObject(words) && Object.values(words).every(value => typeof value === 'number' && value >= 0 && value <= 1),
    'confidence_words maps a word to a number between 0 and 1.');
  return makePrecedence(policy, sameKindOrder, words);
}

function makePrecedence(policy, sameKindOrder, words) {
  const rank = new Map(policy.kinds.map((kind, at) => [kind.id, at]));
  const floor = new Map(policy.kinds.filter(kind => kind.confidence_at_least !== undefined).map(kind => [kind.id, kind.confidence_at_least]));
  const unknownRank = policy.unknown_source === 'holds' ? -1 : policy.kinds.length;

  /** Lower is stronger. A kind not listed, or no kind, ranks by unknown_source. */
  const rankOf = kind => (typeof kind === 'string' && rank.has(kind) ? rank.get(kind) : unknownRank);

  /** A source's confidence as a number, from a number or one of the confidence words; null when it gave none. */
  function confidenceOf(source) {
    const said = source?.confidence;
    if (typeof said === 'number') return said;
    if (typeof said === 'string' && Object.hasOwn(words, said.trim().toLowerCase())) return words[said.trim().toLowerCase()];
    return null;
  }

  /** Why an offer may not win at all (below its kind's floor), or null. */
  function belowFloor(source) {
    if (!floor.has(source?.kind)) return null;
    const confidence = confidenceOf(source);
    return confidence !== null && confidence >= floor.get(source.kind)
      ? null
      : `below the confidence of at least ${floor.get(source.kind)} that ${source.kind} needs`;
  }

  const timeOf = source => (typeof source?.at === 'string' ? Date.parse(source.at) : Number.NEGATIVE_INFINITY);
  // Negative when the first is larger: the larger time or confidence wins.
  const larger = (x, y) => (x === y ? 0 : (x > y ? -1 : 1));
  const breakers = {
    newest: (a, b) => larger(timeOf(a.source), timeOf(b.source)),
    most_confident: (a, b) => larger(confidenceOf(a.source) ?? -1, confidenceOf(b.source) ?? -1),
  };

  /** Negative when offer `a` beats offer `b`; each offer is { source, position: the order it was handed in }. */
  function compare(a, b) {
    const byKind = rankOf(a.source?.kind) - rankOf(b.source?.kind);
    if (byKind !== 0) return byKind;
    for (const id of sameKindOrder) {
      const by = breakers[id](a, b);
      if (by !== 0) return by;
    }
    return a.position - b.position;
  }

  /** The words for why `loser` lost to `winner`. */
  function whyLost(loser, winner) {
    if (rankOf(loser.source?.kind) !== rankOf(winner.source?.kind)) return `a weaker kind of source than ${winner.source?.kind ?? 'an unknown source'}`;
    for (const id of sameKindOrder) {
      const by = breakers[id](loser, winner);
      if (by > 0) return id === 'newest' ? 'older than the winning offer of the same kind' : 'less confident than the winning offer of the same kind';
    }
    return 'handed in after an equal offer of the same kind';
  }

  /** Whether `a` and `b` tie on everything but the order they were handed in. */
  const tied = (a, b) => rankOf(a.source?.kind) === rankOf(b.source?.kind) && sameKindOrder.every(id => breakers[id](a, b) === 0);

  /** Whether a writer of kind `kind` may replace a value held by a source of kind `held` (no stronger, so yes). */
  const mayReplace = (kind, held) => rankOf(held) >= rankOf(kind);

  return { rankOf, confidenceOf, belowFloor, compare, whyLost, tied, mayReplace, kinds: policy.kinds.map(kind => kind.id) };
}
