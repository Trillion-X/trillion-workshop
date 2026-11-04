// parts/screen-arrangement/show/surface-placement.ts
//
// Purpose
//   The one owner of what a screen's input says about where the screen is placed: the arrangement's return address
//   (`surface_intent_destination_ref`) and the tab it is in (`surface_instance_ref`). ContainerHost adds them; a
//   screen that reads by its input takes them off again, so its read is the same wherever it is placed and can be
//   read ahead and kept.
//
// Non-negotiable invariants
//   - Only this file names the placement keys; adding one here takes it off every screen's read at once.
//   - A child tab's stale or configured placement never diverts an explicit placement elsewhere.

/** Add the active arrangement's opaque return address without allowing a child
 * tab's stale/configured value to divert an explicit placement elsewhere. */
export function surfaceInputWithDestination(
  surfaceInput: Record<string, unknown> | undefined,
  destinationRef: string | null | undefined,
  tabId?: string,
  layoutIdentity?: string | null,
): Record<string, unknown> | undefined {
  const destination = destinationRef?.trim()
  if (!destination && !tabId) return surfaceInput
  const { surface_instance_ref: _ignoredInstance, ...input } = surfaceInput ?? {}
  return {
    ...input,
    ...(destination ? { surface_intent_destination_ref: destination } : {}),
    ...(tabId && layoutIdentity ? { surface_instance_ref: JSON.stringify([layoutIdentity, tabId]) } : {}),
  }
}

/** The screen's own input without what `surfaceInputWithDestination` adds to say where it is placed. */
export function surfaceInputWithoutPlacement(surfaceInput: Record<string, unknown> | undefined): Record<string, unknown> {
  const { surface_intent_destination_ref: _destination, surface_instance_ref: _instance, ...input } = surfaceInput ?? {}
  return input
}
