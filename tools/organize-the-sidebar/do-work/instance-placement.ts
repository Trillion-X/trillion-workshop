import { sendRequestToBitfieldTarget } from '#workspace-records';
import { decodeDockablePlacementValue, type DockablePlacementState } from '../../ui/show/dockable-placement';

export function sidebarInstancePlacementAddress(instanceId: string): string {
  if (!instanceId.trim()) throw new Error('A sidebar needs an instance identity.');
  return `package::sidebar::instance-placement::${encodeURIComponent(instanceId)}`;
}

export async function readInstancePlacement(instanceId: string): Promise<DockablePlacementState> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'engine.operation.label-addressed',
    payload: { operation_label: 'engine.operation.read-current', address_label: sidebarInstancePlacementAddress(instanceId), address_mode: 'identity_text' },
  }) as { payload?: Uint8Array };
  if (!reply.payload || !ArrayBuffer.isView(reply.payload)) throw new Error('Sidebar position could not be loaded.');
  const current = JSON.parse(new TextDecoder().decode(reply.payload));
  if (typeof current.found !== 'boolean') throw new Error('Sidebar position could not be loaded.');
  return decodeDockablePlacementValue(current.found ? current.payload : undefined);
}

export async function writeInstancePlacement(instanceId: string, state: DockablePlacementState): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      writes: [{ address_label: sidebarInstancePlacementAddress(instanceId), address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload: state }],
    },
  });
}
