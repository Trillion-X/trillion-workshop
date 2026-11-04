// parts/media-composition/read-data/edit-command-log.mjs
//
// AN EDIT SESSION IS A LOG OF TYPED COMMANDS, SNAPSHOTTED EVERY FEW, SO IT SURVIVES A RELOAD EXACTLY.
//
// Purpose: a person cutting a recording changes cuts, layout, zoom and words many times. Each change is a command a pure reducer
// folds into the state; each command is appended to a store before the state is shown, so a closed tab, a crash or a lost
// connection loses nothing. Every `snapshot_every` commands the whole session (state, undo and redo history) is snapshotted, so
// reopening reads the newest snapshot and replays only the few commands after it. A group of commands (a zoom session) can be
// kept or discarded as one.
//
// Non-negotiable invariants:
//   1. The reducer and the store are handed in: this file names no command type, no state shape and no storage. A command is
//      `{ type, ... }` and the reducer is `(state, command) => state` and pure.
//   2. A command is appended to the store BEFORE the new state is returned to the caller; an append that fails leaves the state
//      as it was and the error reaches the caller.
//   3. Undo and redo are log entries too, so replay reproduces them; a new command clears what could be redone.
//   4. A snapshot holds everything replay needs (state, past, future), so a restore is exact, undo history included.
//   5. The numbers (snapshot interval, undo depth) and the names of the non-edit entries are DATA (./edit-command-log.json).
//
// Store: { append(session, entry), putSnapshot(session, snapshot), latestSnapshot(session), entriesAfter(session, seq) }, each async.
// Entry: { seq, command, at } where command is an edit or one of the DATA marks. Snapshot: { seq, machine }.
import rules from './edit-command-log.json' with { type: 'json' };

const copy = (value) => structuredClone(value);

/** One step of the machine every replay and every live command share. */
function step(machine, command, reduce, settings) {
  const { undo, redo } = settings.marks;
  if (command.type === undo) {
    if (!machine.past.length) return machine;
    return { state: machine.past.at(-1), past: machine.past.slice(0, -1), future: [machine.state, ...machine.future] };
  }
  if (command.type === redo) {
    if (!machine.future.length) return machine;
    return { state: machine.future[0], past: [...machine.past, machine.state], future: machine.future.slice(1) };
  }
  const past = [...machine.past, machine.state];
  return { state: reduce(machine.state, command), past: past.slice(-settings.most_undo), future: [] };
}

/**
 * Opens (or reopens) the session `session` over `store`. -> { state(), apply(command), undo(), redo(), group(), seq() }
 * `initial` is the state of a session that has no snapshot yet.
 */
export async function openEditLog({ session, store, reduce, initial }, settings = rules) {
  const snapshot = await store.latestSnapshot(session);
  let machine = snapshot ? copy(snapshot.machine) : { state: copy(initial), past: [], future: [] };
  let seq = snapshot ? snapshot.seq : 0;
  for (const entry of await store.entriesAfter(session, seq)) { machine = step(machine, entry.command, reduce, settings); seq = entry.seq; }

  const record = async (command) => {
    const next = step(machine, command, reduce, settings);
    if (next === machine) return machine.state;
    await store.append(session, { seq: seq + 1, command: copy(command), at: new Date().toISOString() });
    seq += 1;
    machine = next;
    if (seq % settings.snapshot_every === 0) await store.putSnapshot(session, { seq, machine: copy(machine) });
    return machine.state;
  };
  const api = {
    state: () => machine.state,
    seq: () => seq,
    apply: (command) => record(command),
    undo: () => record({ type: settings.marks.undo }),
    redo: () => record({ type: settings.marks.redo }),
    /** A set of commands kept or discarded as one: `keep()` leaves them done, `discard()` undoes them all. */
    group: () => {
      let applied = 0;
      return {
        apply: async (command) => { const result = await record(command); applied += 1; return result; },
        keep: () => machine.state,
        discard: async () => { for (; applied > 0; applied -= 1) await record({ type: settings.marks.undo }); return machine.state; },
      };
    },
  };
  return api;
}

/** A store held in memory, for a session that needs no survival across a reload and for tests of anything built on this. */
export function memoryEditLogStore() {
  const sessions = new Map();
  const of = (session) => { if (!sessions.has(session)) sessions.set(session, { entries: [], snapshot: null }); return sessions.get(session); };
  return {
    append: async (session, entry) => { of(session).entries.push(copy(entry)); },
    putSnapshot: async (session, snapshot) => { of(session).snapshot = copy(snapshot); },
    latestSnapshot: async (session) => (of(session).snapshot ? copy(of(session).snapshot) : null),
    entriesAfter: async (session, after) => of(session).entries.filter((entry) => entry.seq > after).map(copy),
  };
}
