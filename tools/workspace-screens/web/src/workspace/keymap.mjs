// src/workspace/keymap.mjs
//
// PURPOSE
//   The rules of the one keymap (keymap.json), pure so the page, the Shortcuts settings and the tests read one definition:
//   how a chord is written, read from a key press and shown, which row a press runs, which keys a person may give a row,
//   and what two rows sharing a key means. Nothing here names a verb, a screen or a key; all of that is keymap.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A chord is written once, canonically: modifiers in `modifier_order`, then the key's name from `keys`
//      (`mod+shift+j`). A chord that is not a known key or that repeats a modifier is no chord (parseChord answers null).
//   2. `mod` is Cmd on a Mac and Ctrl elsewhere; a press is read into the same canonical chord on either, so a row written
//      once works on both.
//   3. A person's own keys are overrides by row name (`{ <row name>: chord | null }`); a row with no override has its usual
//      chord, and null taken away leaves the row without a key. A reset removes the override, it never writes the usual key.
//   4. Two rows may share a chord only when one of them is always the one heard: a screen row beats an app row, and a
//      screen scope that is `within` another (a narrower place: an event focused inside the calendar) beats the wider
//      one while both match. Two rows of one scope never share a chord, and a global row shares nothing with any other
//      row, because the computer takes a global key before any page sees it.
//   5. A key pressed alone never runs while the person is typing, and runs only when no control holds the keyboard.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The name a row goes by: its `id`, else its verb. */
export const rowName = row => row.id ?? row.verb;

/** A chord as an object, or null when it is not one of this table's chords. */
export function parseChord(text, table) {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('+');
  const key = parts.pop();
  if (!key || !(key in table.keys)) return null;
  const held = new Set();
  for (const part of parts) {
    if (!table.modifier_order.includes(part) || held.has(part)) return null;
    held.add(part);
  }
  return { modifiers: table.modifier_order.filter(name => held.has(name)), key };
}

/** The canonical text of a chord, or null when it is not one. */
export function normalizeChord(text, table) {
  const chord = parseChord(text, table);
  return chord ? [...chord.modifiers, chord.key].join('+') : null;
}

/** True when the chord has a modifier other than Shift: the computer can be asked for it, and typing never makes it. */
export const hasCommandModifier = chord => chord.modifiers.some(name => name !== 'shift');

/** The chord a key press is, in canonical text; null for a press of a modifier alone or of a key the table does not name. */
export function chordOfEvent(event, table, mac) {
  const key = Object.keys(table.keys).find(name => table.keys[name].code === event.code);
  if (!key) return null;
  const held = new Set();
  if (mac) {
    if (event.metaKey) held.add('mod');
    if (event.ctrlKey) held.add('ctrl');
  } else {
    if (event.ctrlKey) held.add('mod');
    if (event.metaKey) held.add('meta');
  }
  if (event.altKey) held.add('alt');
  if (event.shiftKey) held.add('shift');
  return [...table.modifier_order.filter(name => held.has(name)), key].join('+');
}

/** The chord as the keycaps a person reads (⌘, ⇧, J on a Mac; Ctrl, Shift, J elsewhere). */
export function shownChord(text, table, mac) {
  const chord = parseChord(text, table);
  if (!chord) return [];
  const shown = table.shown_modifiers[mac ? 'mac' : 'other'];
  return [...chord.modifiers.map(name => shown[name]), table.keys[chord.key].shown];
}

/** The rows with the person's own keys laid over their usual ones; each also says whether its key is the person's own. */
export function effectiveRows(table, overrides) {
  const own = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  return table.rows.map(row => {
    const name = rowName(row);
    const set = Object.hasOwn(own, name);
    const chord = set ? (own[name] === null ? null : normalizeChord(own[name], table)) : row.chord;
    // An override that is no chord any more (a key the table dropped) leaves the usual key rather than none.
    const usable = set && (own[name] === null || chord !== null);
    return { ...row, name, chord: usable ? chord : row.chord, own: usable };
  });
}

const scopeOf = (table, row) => table.scopes.find(scope => scope.id === row.scope);

/** How narrow a scope is: the number of scopes it is `within`, one inside the next (a scope with none is 0). */
export function scopeDepth(table, scopeId) {
  let depth = 0;
  for (let scope = table.scopes.find(one => one.id === scopeId); scope?.within; scope = table.scopes.find(one => one.id === scope.within)) {
    depth += 1;
    if (depth > table.scopes.length) return depth;
  }
  return depth;
}

/** Why a row may not take this chord, as the words key to say, or null when it may. */
export function refusalFor(table, rows, row, text) {
  const chord = parseChord(text, table);
  if (!chord) return 'needs_modifier';
  const scope = scopeOf(table, row);
  if (table.reserved.includes([...chord.modifiers, chord.key].join('+'))) return 'reserved';
  if (scope?.kind === 'global' && !hasCommandModifier(chord)) return 'needs_modifier';
  return takenBy(table, rows, row, [...chord.modifiers, chord.key].join('+')) ? 'taken' : null;
}

/** The row, other than this one, that already holds this chord where both would be heard together. */
export function takenBy(table, rows, row, text) {
  const mine = scopeOf(table, row);
  return rows.find(other => {
    if (other.name === (row.name ?? rowName(row)) || other.chord !== text) return false;
    const theirs = scopeOf(table, other);
    // A screen row and any row of another scope never meet: the screen's row is the one heard, the other waits.
    if (mine?.kind === 'global' || theirs?.kind === 'global') return true;
    return mine?.id === theirs?.id;
  }) ?? null;
}

/** The scopes heard right now: every app scope, and each screen scope whose selector matches something on the page. */
export function activeScopes(table, present) {
  return new Set(table.scopes.filter(scope => scope.kind === 'app' || (scope.kind === 'screen' && present(scope.selector))).map(scope => scope.id));
}

/** The row a press runs: the narrowest screen scope that is here beats a wider one, any screen row beats an app row; a row with no handler, no key or a global scope is never run by the page. */
export function rowFor(table, rows, text, active, hasVerb) {
  const heard = rows.filter(row => row.chord === text && active.has(row.scope) && hasVerb(row.verb));
  const screens = heard.filter(row => scopeOf(table, row)?.kind === 'screen');
  const narrowest = screens.reduce((most, row) => Math.max(most, scopeDepth(table, row.scope)), 0);
  return screens.find(row => scopeDepth(table, row.scope) === narrowest) ?? heard[0] ?? null;
}

/** Whether a press may run something now: a key with Command or Control always may; a key that can type a character (alone, with Shift or with Option) not while typing or while a control holds the keyboard. */
export function mayRun(table, text, target, matches) {
  const chord = parseChord(text, table);
  if (!chord) return false;
  if (chord.modifiers.some(name => name === 'mod' || name === 'ctrl' || name === 'meta')) return true;
  if (target && matches(target, table.plain_keys.typing)) return false;
  return !(target && matches(target, table.plain_keys.held));
}

/** What the page tells the Mac app to register: every global row that has a key, with the key's Mac code and modifiers (named as the host's `modifier_flags` name them, `host_modifiers`). */
export function hostRows(table, rows) {
  return rows.flatMap(row => {
    if (scopeOf(table, row)?.kind !== 'global' || !row.chord) return [];
    const chord = parseChord(row.chord, table);
    return chord ? [{ id: row.name, key_code: table.keys[chord.key].mac, modifiers: chord.modifiers.map(name => table.host_modifiers[name]), ...(row.host ? { action: row.host } : {}) }] : [];
  });
}
