// tools/ui/show/pane-slots.ts
//
// PURPOSE
//   A pane element holds one React root per writer kind: its shared state (loading, empty, failed words) and its screen.
//   Each kind draws into its own child slot, created on first use. The slot is found through a symbol every copy of this
//   module shares (a screen module is a separate bundle with its own copy of the code), so every copy finds the same slot.
//   The slot shown is the one asked for; the others are hidden, so a swap never touches another root's nodes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No root is ever created on a node another root has rendered into: a writer kind is a slot, never the pane itself.
//   2. A slot's owner releases only its own slot; the others are not emptied by hand.

const SLOTS = Symbol.for('pane-slots');

/** The slot of `kind` in `host`, created on first use; the other slots of `host` are hidden. */
export function slotOf(host: HTMLElement, kind: string): HTMLElement {
  const slots: Map<string, HTMLElement> = ((host as any)[SLOTS] ??= new Map());
  let slot = slots.get(kind);
  if (!slot) {
    slot = document.createElement('div');
    slot.dataset.paneSlot = kind;
    slot.className = 'h-full min-h-full w-full';
    host.appendChild(slot);
    slots.set(kind, slot);
  }
  for (const [name, other] of slots) other.hidden = name !== kind;
  return slot;
}

/** The slot of `kind` in `host` if one was ever created, without creating it. */
export function existingSlot(host: HTMLElement, kind: string): HTMLElement | undefined {
  return (host as any)[SLOTS]?.get(kind);
}
