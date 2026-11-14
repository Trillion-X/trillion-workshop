// src/workspace/panel-shortcut.mjs
//
// PURPOSE
//   The message contract of the panel's global-shortcut setting (macos/App/MenuBarPanel.swift invariant 10, F-0064),
//   kept apart from the row that draws it so both ends and the test read one definition.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page sends { kind: 'shortcut' } to ask, { kind: 'shortcut', id: '<choice id>' } to pick a choice and
//      { kind: 'shortcut', id: null } to pick Off. The host answers every one of them by calling
//      window.trillionAlone.shortcut({ pick, choices }), pick being the kept choice id or null (Off).
//   2. What the row shows is what the host answered, never what the page assumed; an answer that is not that shape is
//      taken as no answer, so a host that does not know the message shows no row.
//   3. The choices are the host's DATA (macos/App/menu-bar-panel.json shortcut.choices); this file names none.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The message that asks the host for the current pick and the choices. */
export const askShortcut = () => ({ kind: 'shortcut' });

/** The message that picks a choice by its id, or Off when `id` is null. */
export const pickShortcut = id => ({ kind: 'shortcut', id: typeof id === 'string' && id ? id : null });

/** The host's answer as the row shows it, or null when it is not an answer. */
export function shortcutState(answer) {
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.choices)) return null;
  const choices = answer.choices.filter(row => row && typeof row.id === 'string' && row.id && typeof row.title === 'string');
  if (choices.length !== answer.choices.length || choices.length === 0) return null;
  const pick = typeof answer.pick === 'string' && choices.some(row => row.id === answer.pick) ? answer.pick : null;
  return { pick, choices };
}
