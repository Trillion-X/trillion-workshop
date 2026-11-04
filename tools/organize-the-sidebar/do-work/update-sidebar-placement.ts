import { writeInputValue } from '#workspace-records';
import type { SidebarPlacementState } from '../read-data/read-sidebar-placement';

export async function updateSidebarPlacement(value: SidebarPlacementState): Promise<unknown> {
  return writeInputValue('sidebar-placement', value);
}
