// packages/ui/show/keyboard-claim/keyboard-claim.ts
//
// The cross-surface KEYBOARD OWNERSHIP contract — the one primitive every global
// (window/document) key listener composes so that a key CLAIMED by one surface is
// structurally dead to every other surface, while unclaimed keys flow untouched.
//
// WHY THIS EXISTS (live incident 2026-07-10): two package panes open side by side
// each install a global keydown listener (React synthetic key events don't fire on
// engine-hosted subtrees in the WKWebView presenter, so surfaces listen natively).
// One pane's editor claimed Cmd+A with preventDefault ONLY — the event then bubbled
// on to the neighbouring board pane's window listener, which selected every card on
// that board and docked its tools rail over the pane. The user pressed one shortcut
// in one pane and a DIFFERENT pane mutated.
//
// THE CONTRACT (both halves, always paired — each alone leaves a hole):
//   • CLAIM  = preventDefault + stopImmediatePropagation. stopImmediatePropagation
//     kills the event for listeners on every OTHER node and later listeners on the
//     SAME node (window has many, one per pane):
//   • MARK   = defaultPrevented. Same-node listeners run regardless of propagation,
//     so every contract listener STANDS DOWN when the event arrives already claimed.
//
// `withKeyboardClaim` composes both halves around an ordinary handler: it stands
// down on already-claimed events, and seals the handler's own claims (any branch
// that called preventDefault) with stopPropagation afterwards — so a surface's
// existing `event.preventDefault()` claim sites are lifted into the full contract
// without editing each branch.
//
// This is Physics (event-graph mechanics), not Society: it names no surface, no key,
// no package. Any pane, any shortcut, any number of instances.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** Claim a keyboard event for the calling surface: dead to other nodes' listeners
 *  and later same-node listeners, while marked claimed for contract listeners. */
export function claimKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** True when another surface already claimed this event — a contract listener
 *  stands down instead of double-handling the key. */
export function keyboardEventClaimed(event: KeyboardEvent): boolean {
  return event.defaultPrevented;
}

/** Wrap a global keydown handler into the ownership contract: stands down on
 *  already-claimed events; seals any claim the handler made (preventDefault in any
 *  branch) with stopPropagation so it never reaches another pane's listener. */
export function withKeyboardClaim(
  handler: (event: KeyboardEvent) => void,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (keyboardEventClaimed(event)) return;
    handler(event);
    if (event.defaultPrevented) event.stopPropagation();
  };
}
