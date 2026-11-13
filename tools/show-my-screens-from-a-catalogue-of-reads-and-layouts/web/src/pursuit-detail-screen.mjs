// One pursuit in the signed-in workspace, from the person's one list (/pursuits, src/pursuit-rooms.mjs): where it is,
// where it is going, the pursuits around it, and who it is shared with, as facts the Progress catalogue screen draws
// (records/marketplace-screens.json tool:progress; a sealed pursuit's page is drawn there too). Its place with other
// people (its room) is part of the pursuit, not a second thing: Open goes there, and a pursuit nobody else is in yet is
// opened the same way, its place made the first time (src/person-spaces.mjs takes a pursuit id on every room route).

const idsOf = value => Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string') : [];
const pursuitHref = id => `/pursuits/${encodeURIComponent(id)}`;

/**
 * One pursuit's facts for Progress opened on it (records/marketplace-screens.json tool:progress): the pursuit, the
 * pursuits above and inside it, the Marketplace setups saved with it (`installations`, each with only its active public
 * apps), and who it is shared with. Null when the person's list holds no pursuit `focusedId`.
 */
export function pursuitFacts(pursuits, focusedId, installations = []) {
  const rows = Array.isArray(pursuits) ? pursuits : [];
  const byId = new Map(rows.map(item => [item.id, item]));
  const focus = byId.get(focusedId);
  if (!focus) return null;
  const linked = ids => idsOf(ids).filter(id => id !== focusedId && byId.has(id)).map(id => ({ id, title: byId.get(id).title, open: pursuitHref(id) }));
  const others = Array.isArray(focus.others) ? focus.others.filter(name => typeof name === 'string' && name) : [];
  return {
    kind: 'pursuit', id: focus.id, title: focus.title, others: others.length ? others.join(', ') : null,
    now: focus.now || null, after: focus.after || null, why: focus.why_it_matters || null,
    status: focus.status === 'paused' ? 'Paused' : focus.status === 'active' ? 'Active' : 'Recorded',
    place: `/spaces/${encodeURIComponent(focus.space_id || focus.id)}`,
    parents: linked(focus.parents), children: linked(focus.children),
    saved: (Array.isArray(installations) ? installations : []).filter(item => item?.context === 'private' && item.pursuit_id === focusedId)
      .map(item => ({ id: item.id, title: item.title || 'Marketplace setup', setup: `/marketplace/${encodeURIComponent(item.configuration_id)}`,
        apps: (item.public_apps ?? []).filter(app => /^https:\/\//.test(app.public_url ?? '')).map(app => ({ href: app.public_url })) })),
  };
}
