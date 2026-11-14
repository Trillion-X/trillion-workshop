// One sidebar row per private pursuit returned by this person's pursuit store.
// Each row opens the existing Progress screen focused on that record.
// A pursuit that has a room shows its parts as rows of its own list, under its row: the room's own places
// (space-kinds.json `places`: Messages, Files, Board...) and then whatever `partsOf` answers for it (its turned-on places
// and the tools added to it, src/workspace/pursuit-parts.ts). Each part row opens the pursuit's screen on that part
// (trillion.space with { id, place }), so the person's one sidebar is the only navigation a pursuit has. `partsOf`
// answers null for a pursuit whose parts are not shown (only the pursuit the workspace is about shows them).
import { pursuitHierarchyRows } from '../pursuit-hierarchy-view.mjs';
import spaceKinds from './space-kinds.json' with { type: 'json' };

const OWN_PLACES = spaceKinds.places.map(({ id, label, icon }) => ({ id, label, icon }));
const PURSUIT_SCREEN = 'trillion.space';

/** The row id of one part of a pursuit's row. */
export const pursuitPartRowId = (pursuitRowId, place) => `${pursuitRowId}:part:${place}`;

export function pursuitNavigationRows(pursuits, screens, partsOf = () => null) {
  const progress = screens.find(row => row.opens_kinds?.includes('pursuit') && row.route_input === 'pursuit');
  if (!progress) return [];
  const { route_prefix, route_input, opens_kinds, placement_order_key, ...screen } = progress;
  const room = screens.find(row => row.id === PURSUIT_SCREEN);
  const partScreen = room ? (({ route_prefix: _prefix, route_input: _input, route_item_input: _item, opens_kinds: _kinds, placement_order_key: _key, listed: _listed, order: _order, ...rest }) => rest)(room) : null;
  let order = Number(progress.order ?? 0);
  const key = id => `${String(order).padStart(9, '0')}:${id}`;
  return pursuitHierarchyRows(pursuits)
    .filter(({ record }) => typeof record.title === 'string' && record.title.trim())
    .flatMap(({ record, displayParentId }) => {
      const id = `pursuit:${record.id}`;
      order += 1;
      const row = {
        ...screen,
        id,
        surface_id: id,
        source: { kind: 'pursuit-navigation', pursuit_parent_id: displayParentId ? `pursuit:${displayParentId}` : null },
        // A navigation link is not newly created work; keep it out of rule-filled New lists.
        sidebar_new_eligible: false,
        label: record.title.trim(),
        // What is new in its room, on the pursuit's own row (the one list of pursuits has no row of its own to carry it).
        ...(Number(record.unread) > 0 ? { badge: String(record.unread) } : {}),
        route_paths: [`/pursuits/${encodeURIComponent(record.id)}`],
        surface_input: { ...progress.surface_input, pursuit: record.id },
        order,
        placement_order_key: key(id),
      };
      const extra = partScreen && typeof record.space_id === 'string' && record.space_id ? partsOf(record) : null;
      if (!extra) return [row];
      const parts = [...OWN_PLACES, ...extra.filter(place => !OWN_PLACES.some(own => own.id === place.id))]
        .filter(place => typeof place.label === 'string' && place.label.trim() && place.label !== place.tool_id);
      return [row, ...parts.map(place => {
        const partId = pursuitPartRowId(id, place.id);
        order += 1;
        return {
          ...partScreen,
          id: partId,
          surface_id: partId,
          sidebar_collection: progress.sidebar_collection,
          source: { kind: 'pursuit-navigation', pursuit_parent_id: id, part_of_pursuit: true },
          sidebar_new_eligible: false,
          label: place.label,
          ...(place.icon ? { icon: place.icon } : {}),
          // The room's own screen input (the tool it is a screen of, when it is a tool's screen) with the room and its place.
          surface_input: { ...partScreen.surface_input, id: record.space_id, place: place.id },
          order,
          placement_order_key: key(partId),
        };
      })];
    });
}
