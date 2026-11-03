// tools/page-critic/do-work/measure-reduced-motion.mjs
//
// The reduced-motion second pass (F-1119). critique-a-page.mjs opens the page once more with the browser asking for
// reduced motion (`prefers-reduced-motion: reduce`, emulated through DevTools), waits the rule's `settle_ms`, and reads
// every text element with `firstScreenText`; the ordinary pass reads them the same way. Text that was on the first
// screen and seen in the ordinary pass but is still hidden under reduced motion (see-through, visibility hidden, not
// displayed, moved off the screen, clipped away, or gone) is a finding naming that text (`reducedMotionFindings`).
//
// Every threshold, selector and word is the rule row's (read-data/page-craft-rules.json); this file names none.
// `firstScreenText` is injected into the page as text, so it closes over nothing. No browser starts on import.
export function firstScreenText({ rule, selectors, pathOf }) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const ownText = element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
  // Which element it is, by tag and place only: a reveal often adds or takes away a class, so classes cannot name it.
  const placeOf = element => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      const same = node.parentElement ? [...node.parentElement.children].filter(other => other.tagName === node.tagName) : [];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  };
  // Why a person cannot see the element, or null when they can.
  const hiddenBy = element => {
    let opacity = 1;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none') return 'display';
      opacity *= Number(style.opacity);
    }
    if (getComputedStyle(element).visibility !== 'visible') return 'visibility';
    if (opacity < rule.min_opacity) return 'opacity';
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return 'display';
    if (box.right <= 0 || box.left >= vw || box.bottom + window.scrollY <= 0) return 'off_screen';
    // How much of the box is left once every clipping ancestor has cut it.
    let left = box.left, right = box.right, top = box.top, bottom = box.bottom;
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible' && style.clipPath === 'none') continue;
      const clip = node.getBoundingClientRect();
      left = Math.max(left, clip.left); right = Math.min(right, clip.right); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    }
    const kept = Math.max(0, right - left) * Math.max(0, bottom - top) / (box.width * box.height);
    return kept < rule.min_shown_fraction ? 'clipped' : null;
  };
  return [...document.querySelectorAll(selectors.motion_text)].filter(element => ownText(element) && !element.closest(selectors.motion_ignored)).slice(0, rule.most_text).map(element => {
    const box = element.getBoundingClientRect();
    const text = (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return { key: `${placeOf(element)}\u0000${text}`, selector: pathOf(element), text, hidden: hiddenBy(element), first: box.top + window.scrollY < vh && box.bottom + window.scrollY > 0, rect: { x: Math.round(box.left), y: Math.round(box.top + window.scrollY), width: Math.round(box.width), height: Math.round(box.height) } };
  });
}

/** The findings: first-screen text seen in the ordinary pass and still hidden (or gone) under reduced motion. */
export function reducedMotionFindings(ordinary, reduced, rule) {
  const after = new Map(reduced.map(item => [item.key, item]));
  return ordinary.filter(item => item.first && !item.hidden).flatMap(item => {
    const kind = after.has(item.key) ? after.get(item.key).hidden : 'gone';
    return kind ? [{ rule: rule.id, values: { text: item.text, kind, reason: rule.reasons[kind] }, text: item.text, selector: item.selector, rect: item.rect }] : [];
  });
}
