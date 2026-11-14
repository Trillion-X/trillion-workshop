/**
 * Keep a box pinned at the bottom of what it sits in (a message box under a conversation) out from under the
 * floating controls docked at the viewport bottom. `reserveBottomFloatingInset` publishes how much of the viewport
 * bottom those controls cover as `--floating-occlusion-bottom`; while this box's own bottom reaches into that band, it
 * is given `--floating-lift` (how far it reaches in) and marked `data-floating-lift`, and screen-look adds that much
 * room under it, so it lifts clear. A box that sits higher up the page is never moved. Nothing here knows what the box
 * or the control is: only the published band and where the browser says the box is.
 */
const MARK = 'data-floating-lift';
const LIFT = '--floating-lift';
const BAND = '--floating-occlusion-bottom';

/** Tracks one box; the returned function releases it. */
export function liftAboveFloating(node: HTMLElement): () => void {
  const doc = node.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let lifted = 0;
  const update = () => {
    const band = Number.parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue(BAND)) || 0;
    const rect = node.getBoundingClientRect();
    // Where the box's bottom would be without the room already added under it.
    const reach = band && node.isConnected && rect.height > 0 ? Math.ceil(rect.bottom + lifted - (win.innerHeight - band)) : 0;
    const next = reach > 0 && reach <= band ? reach : 0;
    if (next === lifted) return;
    lifted = next;
    if (next) { node.setAttribute(MARK, ''); node.style.setProperty(LIFT, `${next}px`); }
    else { node.removeAttribute(MARK); node.style.removeProperty(LIFT); }
  };
  let frame = 0;
  const soon = () => { if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; update(); }); };
  // The band is a property on the document root, so a change to it arrives as a change to the root's style.
  const band = typeof MutationObserver === 'function' ? new MutationObserver(soon) : null;
  band?.observe(doc.documentElement, { attributes: true, attributeFilter: ['style'] });
  const size = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
  size?.observe(node);
  win.addEventListener('resize', soon);
  soon();
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    band?.disconnect();
    size?.disconnect();
    win.removeEventListener('resize', soon);
    node.removeAttribute(MARK);
    node.style.removeProperty(LIFT);
  };
}
