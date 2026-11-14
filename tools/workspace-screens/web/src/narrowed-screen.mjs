// src/narrowed-screen.mjs
//
// PURPOSE
//   One screen's description narrowed to what its address asks for (show_section, show_row), for every road that
//   answers a screen's description: the generic screen host (src/screen-host.mjs) and the guide screens still built in
//   src/account-routes.mjs. Its words are DATA (./narrowed-screen.json).
import narrowedScreen from './narrowed-screen.json' with { type: 'json' };

/**
 * One screen's description narrowed to what an address asks for, so a place that shows one control of a screen (the
 * hold showing the saved-logins switch, a step showing one saved login in place) opens the same screen with the same
 * actions, only less of it: `show_section` keeps the sections whose id it names, `show_row` keeps, inside them, the rows
 * it names (drawn as plain rows, never a list to search). Both are read leniently, as an AI or a person writes them:
 * trimmed, without surrounding quotes, any case, several comma separated. A row is named by its title or id, and a
 * saved login also by its `login:<id>`, its site's host and its user name (the row's own facts, never a value). Without
 * either, or when `show_row` names no row (and `show_section` no section), the description is as built, never an empty
 * screen. A narrowed one draws no header (`hide_header`) and says it is narrowed (`narrowed`), which draws the control
 * that shows all of it again (narrowed-screen.json).
 */
const unquoted = text => String(text ?? '').trim().replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '').toLowerCase();
const askedFor = value => [...new Set([unquoted(value), ...String(value ?? '').split(',').map(unquoted)])].filter(Boolean);
const hostOfSite = site => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
function rowNames(row) {
  const login = typeof row.id === 'string' && row.id.startsWith('login:');
  return [row.title, row.id, ...(login ? [row.pick, row.facts?.user, row.facts?.site, hostOfSite(row.facts?.site ?? '')] : [])].map(unquoted).filter(Boolean);
}

// A nested row is reached through its real ancestors. Keep only the branch
// asked for, open its ancestors, and preserve the target's own details/actions.
function matchingRows(rows, names, depth = 0) {
  if (depth > 32) return [];
  return rows.flatMap(row => {
    if (rowNames(row).some(name => names.includes(name))) return [{ ...row, starts_open: true }];
    const children = Array.isArray(row.children) ? matchingRows(row.children, names, depth + 1) : [];
    return children.length ? [{ ...row, children, starts_open: true }] : [];
  });
}

export function narrowedTo(description, query) {
  const sections = askedFor(query.get('show_section'));
  const rows = askedFor(query.get('show_row'));
  if (!sections.length && !rows.length) return description;
  const found = sections.length ? (description.sections ?? []).filter(section => sections.includes(unquoted(section.id))) : [];
  const kept = (found.length ? found : description.sections ?? [])
    .map(section => {
      if (!rows.length || !Array.isArray(section.rows)) return section;
      // One row asked for is shown as itself: a list's search, views and sorting have nothing to do over one row.
      const { catalog: _catalog, ...plain } = section;
      // It opens with its steps showing, so what to press and what happens next are both in sight.
      return { ...plain, rows: matchingRows(section.rows, rows) };
    })
    // One row asked for is the only thing shown: a section with no rows (a screen's steps, its other parts) is about
    // the rest of the screen, so it goes too.
    .filter(section => !rows.length || (Array.isArray(section.rows) && section.rows.length));
  // Naming nothing here is not an empty screen: a row found in no section leaves the sections found whole, and no
  // section found leaves the screen as built.
  const shown = kept.length ? kept : found;
  if (!shown.length || (!rows.length && !found.length)) return description;
  // The place showing part of a screen says what it is about, so the screen's own header is left to it.
  const { lead: _lead, ...rest } = description;
  return { ...rest, hide_header: true, narrowed: narrowedScreen, sections: shown };
}

