/**
 * Keep a fixed floating control (the corner button every screen shows) from sitting on the end of what scrolls under
 * it. The scrolling area beneath the control is marked with `data-floating-clearance` and given the control's covered
 * height as `--floating-clearance`; screen-look ends that area with room of that height, so its last card can always
 * be scrolled out from under the control. Nothing here knows what a screen or a pane is: the area is whatever the
 * browser says scrolls at the control's position.
 */
const MARK = 'data-floating-clearance';
const PROPERTY = '--floating-clearance';

const scrolls = (el: Element, win: Window) => {
  const overflow = win.getComputedStyle(el).overflowY;
  return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight;
};

/** Tracks one fixed control; the returned function releases the area it marked. */
export function clearScrollBeneath(node: HTMLElement, gutter = 12): () => void {
  const doc = node.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let marked: HTMLElement | null = null;
  const release = () => {
    if (!marked) return;
    marked.removeAttribute(MARK);
    marked.style.removeProperty(PROPERTY);
    marked = null;
  };
  const update = () => {
    const rect = node.getBoundingClientRect();
    if (!node.isConnected || node.hidden || rect.height === 0) { release(); return; }
    const beneath = doc.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      .find(el => el !== node && !node.contains(el));
    let area: Element | null = beneath ?? null;
    while (area && area !== doc.documentElement && !scrolls(area, win)) area = area.parentElement;
    const next = area instanceof win.HTMLElement && area !== doc.documentElement && area !== doc.body ? area : null;
    if (next !== marked) release();
    if (!next) return;
    marked = next;
    next.setAttribute(MARK, '');
    next.style.setProperty(PROPERTY, `${Math.ceil(win.innerHeight - rect.top + gutter)}px`);
  };
  let frame = 0;
  const soon = () => { if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; update(); }); };
  // A tab can change under the control without any event reaching it, so it also looks again every second.
  const timer = win.setInterval(soon, 1000);
  win.addEventListener('resize', soon);
  doc.addEventListener('scroll', soon, true);
  soon();
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    win.clearInterval(timer);
    win.removeEventListener('resize', soon);
    doc.removeEventListener('scroll', soon, true);
    release();
  };
}
