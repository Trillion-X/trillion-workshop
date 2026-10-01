// A record occupies one of a declared set of states, moves between them only where a declared
// transition allows it, and every move is recorded.
//
// This file names no domain, no track, no state and no package. It is given descriptors and a
// move history; it answers which moves are legal and where a record currently is. Whether to
// perform a move is the caller's decision, the same split the rule judge beside it uses when it
// reports findings and lets the caller decide whether a build fails.
//
// WHY THIS EXISTS. Five packages carried their own state-shaped record kind, each found by grepping
// the kind and reading which manifest declares it. The occasion was `activation-manager`, which had
// correct generic descriptors, nowhere to put them, and so invented a package name after its use
// case and never built it. A sixth, `hosted-public-app`, invented a three-phase
// reserve/finalize/reconcile protocol alone, while two sweeps over six vocabularies each found no
// state-transition record kind in the corpus.
//
// ⛔ THOSE FIVE ARE NOT FIVE INSTANCES OF ONE MIGRATION, and the sentence above reads as though
// they were. The README beside this file owns the per-package breakdown, measured by opening all
// five payloads rather than reading their kind names: exactly one is a declared state set, three
// store a per-subject CURRENT STATE and can migrate the `state-move` half only, and one is a role
// map with no transition relation and nothing here to adopt. Read it before planning any migration;
// it is not repeated here, because two copies of that table is how the two ended up disagreeing.
//
// ADOPTED 2026-09-05, the one true match: `activation-manager`'s `lifecycle-bucket-descriptor` was
// field for field `{key,label,tone,rank,terminal,track}`. It now carries `state-descriptor` rows
// addressed under its own package name and that kind no longer exists.
//
// WHAT THIS FILE MUST REFUSE, which is the part that belongs next to the code rather than in the
// README. Those three stored-current-state packages create a pull to declare a fourth
// `state-instance` contract so they have somewhere to land unchanged. DO NOT. `currentState` below
// derives position from the move history precisely so that a stored current state is not a second
// source of truth, which is the defect this package exists to prevent. Such a row would contradict
// the file it was added to, and the migration it would paper over is the real work: recording moves
// instead of overwriting a snapshot.
//
// This comment said SIX and listed `plan-lifecycle`, from that package's NAME rather than its
// data. It declares no state kind; it reads a `lifecycle_state` string off the latest authority
// effect, which is a projection and not a declared state set, so it is not a migration candidate.
// Judging a package by its name is the failure this file's own occasion is about.
//
// NO DEPENDENCY, deliberately. A state-machine library solves the machine, and the machine is the
// cheap half; reachability over a declared edge set is a first-year exercise. What was missing is
// the RECORD KIND, so that a corpus-wide question can be asked without eight adapters, and a
// record kind is not something a dependency can supply.
//
// THREE REFUSALS, and each one is a defect somebody would otherwise ship silently:
//
//   1. A TERMINAL STATE MAY NOT HAVE AN OUTGOING TRANSITION. Not a warning, a throw, at read
//      time, once. `terminal: true` is the whole reason a lifecycle is not a band: under band
//      membership a customer who goes quiet after onboarding recomputes backwards into the
//      going-quiet band and is welcomed a second time. Making the edge impossible to declare turns
//      that from a bug somebody must remember into one nobody can write. The relation is refused
//      because it CONTRADICTS ITSELF: one record says the state is absorbing, another says here is
//      the way out. Accepting both and picking one silently is how the second email gets sent. To
//      legitimately open a terminal state, change the DESCRIPTOR, because that is the claim that
//      became false.
//   2. A TRANSITION NAMING AN UNDECLARED STATE THROWS. A typo in `to` would otherwise create a
//      state that exists only in an edge, reachable and undescribable, which reads as a working
//      transition until something tries to render its label.
//   3. CURRENT STATE IS REPLAYED FROM MOVES, NEVER STORED BESIDE THEM. Two representations of one
//      fact diverge silently, and this divergence is invisible: a stored `status` that disagrees
//      with history is still a valid-looking string.
//
// The condition algebra is CLOSED (all, any, equals, at_least, at_most, absent) the way Option and
// Result are closed. It is not an open set a caller extends; a caller extends the DESCRIPTORS.
//
// MEASUREMENT IS NOT OWNED HERE. `signals` arrives as an argument and is computed nowhere in this
// package. Bands over a measured signal already have an owner, `progression-evaluator`, and the
// seam is exact: bands compute a candidate signal, transitions decide whether the move is legal.

/** Every declared state, by key.
 *
 *  A duplicate key is refused rather than last-one-wins, because two descriptors for one state is
 *  the SSOT defect this package exists to prevent, and silently keeping one of them would decide
 *  which by document order. */
export function statesByKey(stateDescriptors) {
  const byKey = new Map();
  for (const state of stateDescriptors ?? []) {
    if (typeof state?.key !== 'string' || state.key === '') {
      throw new Error(`a state descriptor needs a non-empty string key: ${JSON.stringify(state)}`);
    }
    if (byKey.has(state.key)) {
      throw new Error(`two state descriptors declare the key "${state.key}"; one state has one descriptor`);
    }
    byKey.set(state.key, state);
  }
  return byKey;
}

const declared = (states) => [...states.keys()].join(', ') || 'nothing';

/** The declared transition relation, checked against the states it names.
 *
 *  Validation happens HERE rather than at move time on purpose: a malformed relation is wrong for
 *  every record forever, so it should fail once at read, loudly, not once per record, quietly. */
export function transitionsFrom(transitionDescriptors, states) {
  const transitions = [];
  for (const edge of transitionDescriptors ?? []) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') {
      throw new Error(`a transition needs string from and to: ${JSON.stringify(edge)}`);
    }
    if (!states.has(edge.from)) {
      throw new Error(`transition from "${edge.from}" names no declared state. Declared: ${declared(states)}`);
    }
    if (!states.has(edge.to)) {
      throw new Error(`transition to "${edge.to}" names no declared state. Declared: ${declared(states)}`);
    }
    // Refusal 1. The message says WHY and names the fix, because the next person to hit this is
    // trying to express something real and needs the shape that carries it.
    if (states.get(edge.from).terminal === true) {
      throw new Error(
        `state "${edge.from}" is terminal and cannot have an outgoing transition to "${edge.to}". `
        + 'A terminal state is absorbing by declaration. If this record really should leave it, the '
        + 'state is not terminal, and the descriptor is what should change.',
      );
    }
    transitions.push(edge);
  }
  return transitions;
}

/** A signal that is missing or not a number never satisfies a threshold.
 *
 *  NaN is deliberate. Returning 0 would make `at_most` true for an absent signal, so a record with
 *  no measurement at all would satisfy "quiet for at most 14 days" and move, which is the reading
 *  a caller would least expect from missing data. Every comparison with NaN is false, so an absent
 *  signal blocks BOTH directions and a caller who means "not measured yet" must say `absent`. */
function numeric(signals, name) {
  const value = signals?.[name];
  return typeof value === 'number' ? value : Number.NaN;
}

/** Does a set of named signals satisfy a declared condition?
 *
 *  Self-describing: the SHAPE says which test to run, so there is no `kind` discriminator string
 *  and no registry of operator names to keep in sync. An unrecognised shape throws, because a
 *  condition that quietly evaluated false would make a transition permanently unreachable and look
 *  exactly like a correctly restrictive relation. */
export function conditionHolds(condition, signals) {
  if (condition == null) return true;
  if (Array.isArray(condition.all)) return condition.all.every((c) => conditionHolds(c, signals));
  if (Array.isArray(condition.any)) return condition.any.some((c) => conditionHolds(c, signals));
  if (condition.equals) return signals?.[condition.equals.signal] === condition.equals.value;
  if (condition.at_least) return numeric(signals, condition.at_least.signal) >= condition.at_least.value;
  if (condition.at_most) return numeric(signals, condition.at_most.signal) <= condition.at_most.value;
  if (typeof condition.absent === 'string') {
    return signals == null || !Object.hasOwn(signals, condition.absent) || signals[condition.absent] == null;
  }
  throw new Error(`unrecognised condition, expected all/any/equals/at_least/at_most/absent: ${JSON.stringify(condition)}`);
}

/** Where a record is now, from its own history.
 *
 *  Reads the LAST move, which is O(1), not a fold. History exists so current state is DERIVABLE
 *  rather than a second source of truth, and derivability does not require re-derivation.
 *
 *  Moves arrive already ordered, and are not sorted here. What "in order" means is a storage
 *  question and this file has no storage; a caller that sorts an unbounded move list on every read
 *  has moved the cost rather than removed it, and a per-record index is ordinary where the moves
 *  actually live.
 *
 *  A record with no moves is in the declared start state. Having no start state is an error rather
 *  than an implicit null, because a record in no state cannot be reasoned about and would silently
 *  match no transition, which is indistinguishable from a correctly stuck record. */
export function currentState(moves, states, startKey) {
  const applied = moves ?? [];
  if (applied.length === 0) {
    if (!states.has(startKey)) {
      throw new Error(`no moves, and start state "${startKey}" is not declared. Declared: ${declared(states)}`);
    }
    return startKey;
  }
  const last = applied[applied.length - 1];
  if (!states.has(last?.to)) {
    throw new Error(`the last move lands on "${last?.to}", which is not a declared state. Declared: ${declared(states)}`);
  }
  return last.to;
}

/** Every move this record could make right now, and why each one is or is not available.
 *
 *  Returns BOTH the allowed and the refused with a reason, rather than filtering. A caller that
 *  only receives the allowed list cannot tell "no transition exists" from "the transition exists
 *  and its condition is not met yet", and those need opposite responses: the first is a design gap
 *  to fix, the second is ordinary waiting. */
export function movesAvailable({ states, transitions, from, signals }) {
  if (!states.has(from)) {
    throw new Error(`"${from}" is not a declared state. Declared: ${declared(states)}`);
  }
  return transitions
    .filter((edge) => edge.from === from)
    .map((edge) => (
      conditionHolds(edge.when, signals)
        ? { to: edge.to, allowed: true, reason: null }
        : { to: edge.to, allowed: false, reason: 'the declared condition is not met' }
    ));
}

/** May this record move from where it is to where the caller wants it?
 *
 *  One place answers this, so a refusal and a rehearsal can never disagree about what is legal. */
export function moveIsAllowed({ states, transitions, from, to, signals }) {
  if (!states.has(to)) return { allowed: false, reason: `"${to}" is not a declared state` };
  if (states.get(from)?.terminal === true) {
    return { allowed: false, reason: `"${from}" is terminal, so this record does not move again` };
  }
  const match = movesAvailable({ states, transitions, from, signals }).find((option) => option.to === to);
  if (!match) return { allowed: false, reason: `no declared transition goes from "${from}" to "${to}"` };
  return match.allowed ? { allowed: true, reason: null } : { allowed: false, reason: match.reason };
}

/** The move record to write when a caller decides to move.
 *
 *  It BUILDS the record and writes nothing, which is the same split the rest of this corpus uses:
 *  storage belongs to whoever owns the log. `at` is supplied by the caller rather than read from a
 *  clock here, so this file stays pure and a test does not have to freeze time to be deterministic.
 *
 *  Refuses an illegal move rather than recording it with a flag. A recorded illegal move is worse
 *  than a refusal, because history then contains a step the relation calls impossible, and every
 *  later replay inherits it. */
export function moveRecordFor({ states, transitions, from, to, signals, at, because = null }) {
  const verdict = moveIsAllowed({ states, transitions, from, to, signals });
  if (!verdict.allowed) throw new Error(`refused: ${verdict.reason}`);
  if (typeof at !== 'string' || at === '') {
    throw new Error('a move needs an `at` supplied by the caller; this file reads no clock');
  }
  return { from, to, at, because };
}

/** Every state reachable from here, following declared transitions and IGNORING conditions.
 *
 *  Conditions are ignored deliberately: this answers "is the design connected", not "can this
 *  record go there today". Both questions are real, and mixing them produces an answer that is
 *  wrong for each. */
export function reachableFrom(transitions, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const here = queue.shift();
    for (const edge of transitions) {
      if (edge.from === here && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

/** States nothing can ever reach from the start.
 *
 *  A design check rather than a runtime one, and it is the state-machine twin of the defect that
 *  produced this package: a state descriptor with a label and a tone that no path leads to renders
 *  in every picker, reads as a working option, and is chosen by nobody forever, exactly as a
 *  declared address pointing at a package nobody built resolves to nothing and reports success. */
export function unreachableStates(states, transitions, startKey) {
  const reachable = reachableFrom(transitions, startKey);
  return [...states.keys()].filter((key) => !reachable.has(key));
}
