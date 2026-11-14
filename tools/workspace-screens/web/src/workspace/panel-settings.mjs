// src/workspace/panel-settings.mjs
//
// PURPOSE
//   The message contract of the Mac menu bar item's own settings (macos/App/MenuBarPanel.swift invariant 12, F-0994):
//   whether the item is shown, how far ahead a meeting is counted down to, how long its title may be and the app
//   icon. Kept apart from the rows that draw it so both ends, the glance and the test read one definition.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page sends { kind: 'panel_settings' } to ask and { kind: 'panel_settings', id, value } to set one row. The host
//      answers every one of them by calling window.trillionAlone.panelSettings({ rows }), each row
//      { id, kind, value, choices?, least?, most?, step? }; kind is switch (value true/false), choice (value a choice id)
//      or range (value a number between least and most).
//   2. What a row shows is what the host answered, never what the page assumed; an answer that is not that shape is taken
//      as no answer, so a host that does not know the message shows no rows.
//   3. The rows, their choices and their limits are the host's DATA (macos/App/menu-bar-panel.json settings.rows); this
//      file names none. Only a row's words are the page's (src/alone-page.json words.settings, by row id).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The message that asks the host for every row and its value. */
export const askPanelSettings = () => ({ kind: 'panel_settings' });

/** The message that sets one row to a value. */
export const setPanelSetting = (id, value) => ({ kind: 'panel_settings', id, value });

const KINDS = {
  switch: row => typeof row.value === 'boolean',
  choice: row => Array.isArray(row.choices) && row.choices.length > 0
    && row.choices.every(choice => choice && typeof choice.id === 'string' && choice.id && typeof choice.title === 'string')
    && row.choices.some(choice => choice.id === row.value),
  range: row => [row.least, row.most, row.step, row.value].every(Number.isFinite) && row.least < row.most && row.step > 0
    && row.value >= row.least && row.value <= row.most,
};

/** The host's answer as the rows show it, or null when it is not an answer. */
export function panelSettingsState(answer) {
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.rows) || answer.rows.length === 0) return null;
  const rows = answer.rows.filter(row => row && typeof row.id === 'string' && row.id && Object.hasOwn(KINDS, row.kind) && KINDS[row.kind](row));
  return rows.length === answer.rows.length ? { rows } : null;
}

/** One row's value from an answer already taken by panelSettingsState, or `fallback` when the host has no such row. */
export const panelSettingValue = (state, id, fallback) => state?.rows.find(row => row.id === id)?.value ?? fallback;
