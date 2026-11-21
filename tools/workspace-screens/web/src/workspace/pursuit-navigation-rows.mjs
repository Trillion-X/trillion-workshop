// One sidebar row per pursuit the person has (pursuit-list.mjs: one per vault connection that is a pursuit).
// Each row opens the existing Progress screen focused on that pursuit.
// A pursuit shows its parts as rows of its own list, under its row: the screens `partsOf` answers for it (the screens
// whose row says they belong in a pursuit, src/workspace/pursuit-parts.ts). Each part row is that screen itself, nested
// under its pursuit, so the person's one sidebar is the only navigation a pursuit has. `partsOf` answers null for a
// pursuit whose parts are not shown (only the pursuit the workspace is about shows them).
import { pursuitHierarchyRows } from '../pursuit-hierarchy-view.mjs';

const PURSUIT_SCREEN_OPENS = 'pursuit';

/** The row id of one part of a pursuit's row. */
export const pursuitPartRowId = (pursuitRowId, screenId) => `${pursuitRowId}:part:${screenId}`;

export function pursuitNavigationRows(pursuits, screens, partsOf = () => null) {
  const progress = screens.find(row => row.opens_kinds?.includes(PURSUIT_SCREEN_OPENS) && row.route_input === PURSUIT_SCREEN_OPENS);
  if (!progress) return [];
  const { route_prefix, route_input, opens_kinds, placement_order_key, ...screen } = progress;
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
        route_paths: [`/pursuits/${encodeURIComponent(record.id)}`],
        surface_input: { ...progress.surface_input, pursuit: record.id },
        order,
        placement_order_key: key(id),
      };
      const parts = partsOf(record);
      if (!parts) return [row];
      return [row, ...parts.map(part => {
        const partId = pursuitPartRowId(id, part.id);
        order += 1;
        return {
          ...part,
          id: partId,
          surface_id: partId,
          sidebar_collection: progress.sidebar_collection,
          source: { kind: 'pursuit-navigation', pursuit_parent_id: id, part_of_pursuit: true },
          sidebar_new_eligible: false,
          order,
          placement_order_key: key(partId),
        };
      })];
    });
}
