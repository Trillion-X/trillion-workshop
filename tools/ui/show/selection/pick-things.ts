// parts/ui/show/selection/pick-things.ts
//
// NO PRIOR: searched bitfield-packages/packages for "pick", "pointer picking", "select anything", "element picker" and
// "inspect element". The ported pieces it stands on are this folder's marquee-selection.mjs (the dragged box) and
// node-actions/node-ref.ts (the stamped identities a page already carries); what a thing on the page is comes from the
// caller's rules, so nothing here names a screen, a row or a message.
//
// PURPOSE
//   Picking things anywhere on a page into a tray (tray-store.ts): while the tray is picking, a click (or a shift- or
//   Cmd-click) on anything takes the nearest thing under it, a second click on it puts it back, a dragged box takes
//   every thing it touches, and Escape stops picking; at any time, the thing under the last right-click is ready for a
//   menu entry ("Add to tray") to take. What counts as a thing is DATA: each rule names a selector, the kind of thing
//   it marks, its icon, and which attribute (if any) holds its identity and its name.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The nearest match wins: a row inside a screen is the row, the screen only where no finer rule matches.
//   2. Picking never opens, follows or presses what it picks: the click is stopped before the page sees it.
//   3. The tray's own controls (the caller's `ignore` selector) are never picked and keep working while picking.
//   4. A thing's key is its rule's kind, the place it was picked in, and its identity attribute or, without one, its
//      screen and name, so the same thing picked twice is one thing and the same screen in two spaces is two.

import { trayKeyOf, type TrayStore, type TrayThing } from './tray-store';
import { mountMarqueeSelection } from './marquee-selection.mjs';

/** One kind of thing on the page, as DATA. */
export type PickRule = {
  selector: string;
  kind: string;
  icon?: string;
  /** The attribute holding this thing's identity, when it has one. */
  id_attribute?: string;
  /** The exact reference accepted by the sharing owner, if this thing is shareable. */
  share_attribute?: string;
  /** A prefix to apply to the thing's id when the page stores only the suffix (for example `file:`). */
  share_prefix?: string;
  /** An attribute whose http(s) value is a shareable web address (for example an anchor's href). */
  share_url_attribute?: string;
  /** Preserve the selected element's visible words/value as a shareable text item. */
  share_text?: boolean;
  /** Attributes holding its name, tried in order before its visible words. */
  label_attributes?: string[];
  /** Named by the screen it is (a whole pane), not by its words. */
  named_by_screen?: boolean;
};

export type PickOptions = {
  store: TrayStore;
  rules: readonly PickRule[];
  /** The tray's own controls: never picked, always usable. */
  ignore: string;
  /** The longest name kept for a thing, in characters. */
  labelLength?: number;
  /** A screen's name from the pane mark the page gives it. */
  screenName?: (screen: string) => string | undefined;
  /** The attribute that marks which screen a pane holds. */
  screenAttribute?: string;
  /** Where things are worked on: the kinds of opened thing that are a place of work (a space), and the attributes
   *  a pane carries naming the one thing it holds. A thing picked inside such a pane carries it as its context. */
  contexts?: { kinds: readonly string[]; kindAttribute: string; idAttribute: string };
  /** Marks set on the page while picking and on the thing under the pointer, for the look to draw. */
  pickingAttribute?: string;
  pointedAttribute?: string;
};

const firstLine = (text: string, length: number) => {
  const line = text.split('\n').map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** A shareable row owns its preview and controls when picking a record. */
function shareableAncestor(start: Element, rules: readonly PickRule[]): { element: Element; rule: PickRule } | null {
  for (const rule of rules) {
    if (!rule.share_attribute && !rule.share_prefix && !rule.share_url_attribute && !rule.share_text) continue;
    const element = start.closest(rule.selector);
    if (!element) continue;
    if (rule.share_attribute && element.getAttribute(rule.share_attribute)) return { element, rule };
    if (rule.share_prefix && rule.id_attribute && element.getAttribute(rule.id_attribute)) return { element, rule };
    if (rule.share_url_attribute && element.getAttribute(rule.share_url_attribute)) return { element, rule };
    if (rule.share_text) return { element, rule };
  }
  return null;
}

const httpAddress = (value: string | null): string | undefined => {
  if (!value) return undefined;
  try {
    const address = new URL(value, location.href);
    return address.protocol === 'http:' || address.protocol === 'https:' ? address.href : undefined;
  } catch {
    return undefined;
  }
};

const elementWords = (element: Element): string => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
  return element.textContent ?? '';
};

/** The nearest thing at `target` by the rules, or null when nothing there is a thing. */
export function thingAt(target: EventTarget | null, options: PickOptions): TrayThing | null {
  const start = target instanceof Element ? target : null;
  if (!start || start.closest(options.ignore)) return null;
  const shared = shareableAncestor(start, options.rules);
  if (shared) return thingOf(shared.element, shared.rule, options);
  let best: { element: Element; rule: PickRule } | null = null;
  for (const rule of options.rules) {
    const element = start.closest(rule.selector);
    if (element && (!best || best.element.contains(element))) best = { element, rule };
  }
  return best ? thingOf(best.element, best.rule, options) : null;
}

function thingOf(element: Element, rule: PickRule, options: PickOptions): TrayThing | null {
  const length = options.labelLength ?? 80;
  const screenAttribute = options.screenAttribute ?? 'data-trillion-screen';
  const named = [...(rule.label_attributes ?? []), 'aria-label', 'title'].map(name => element.getAttribute(name)).find(value => value && value.trim());
  const screen = element.closest(`[${screenAttribute}]`)?.getAttribute(screenAttribute) ?? undefined;
  const screenLabel = screen ? options.screenName?.(screen) : undefined;
  const label = (rule.named_by_screen ? screenLabel : undefined) || firstLine(named ?? (element instanceof HTMLElement ? element.innerText : element.textContent ?? ''), length) || screenLabel || rule.kind;
  const id = rule.id_attribute ? element.getAttribute(rule.id_attribute) ?? undefined : undefined;
  const explicitShareRecord = rule.share_attribute ? element.getAttribute(rule.share_attribute) ?? undefined : undefined;
  const prefixedShareRecord = rule.share_prefix && id
    ? (id.startsWith(rule.share_prefix) ? id : `${rule.share_prefix}${id}`)
    : undefined;
  const shareRecord = explicitShareRecord ?? prefixedShareRecord;
  const shareUrl = rule.share_url_attribute ? httpAddress(element.getAttribute(rule.share_url_attribute)) : undefined;
  // Keep accepted words intact. One extra marker lets the sender refuse an oversized selection truthfully without
  // keeping an unbounded page of text in the tray, even when its first 20,000 characters are whitespace.
  const words = rule.share_text ? elementWords(element) : '';
  const shareText = words.trim() ? (words.length > 20000 ? `${words.slice(0, 20000)}…` : words) : undefined;
  const place = options.contexts ? element.closest(`[${options.contexts.kindAttribute}]`) : null;
  const placeKind = place?.getAttribute(options.contexts!.kindAttribute);
  const placeId = place?.getAttribute(options.contexts!.idAttribute);
  const context = placeKind && placeId && options.contexts!.kinds.includes(placeKind) ? { kind: placeKind, id: placeId } : undefined;
  return {
    key: trayKeyOf({ kind: rule.kind, label, id, screen, share_record: shareRecord, context }),
    kind: rule.kind,
    label,
    ...(rule.icon ? { icon: rule.icon } : {}),
    ...(screen ? { screen } : {}),
    ...(screenLabel ? { screen_label: screenLabel } : {}),
    address: location.pathname,
    ...(id ? { id } : {}),
    ...(shareRecord ? { share_record: shareRecord } : {}),
    ...(shareUrl ? { share_url: shareUrl } : {}),
    ...(shareText ? { share_text: shareText } : {}),
    ...(context ? { context } : {}),
  };
}

/** Starts picking on the page; answers the thing under the last right-click, and a way to stop. */
export function installPicking(options: PickOptions): { pointed(): TrayThing | null; destroy(): void } {
  const { store } = options;
  const pickingAttribute = options.pickingAttribute ?? 'data-tray-picking';
  const pointedAttribute = options.pointedAttribute ?? 'data-tray-pointed';
  let rightClicked: EventTarget | null = null;
  let pointedElement: Element | null = null;
  let skipClickAfterDrag = false;
  const selectorOfAll = options.rules.map(rule => rule.selector).join(',');
  const elementOf = (target: EventTarget | null): Element | null => {
    const start = target instanceof Element ? target : null;
    if (!start || start.closest(options.ignore)) return null;
    const shared = shareableAncestor(start, options.rules);
    if (shared) return shared.element;
    let best: Element | null = null;
    for (const rule of options.rules) {
      const element = start.closest(rule.selector);
      if (element && (!best || best.contains(element))) best = element;
    }
    return best;
  };
  const point = (element: Element | null) => {
    if (pointedElement === element) return;
    pointedElement?.removeAttribute(pointedAttribute);
    pointedElement = element;
    element?.setAttribute(pointedAttribute, '');
  };

  const onContextMenu = (event: Event) => { rightClicked = event.target; };
  const onMove = (event: PointerEvent) => { if (store.read().picking) point(elementOf(event.target)); };
  const onClick = (event: MouseEvent) => {
    // The click synthesized after a drag reaches this capture listener before the marquee's later
    // click suppressor. The box already picked its items; do not also pick the screen underneath.
    if (skipClickAfterDrag) { skipClickAfterDrag = false; return; }
    if (!store.read().picking || event.button !== 0) return;
    const thing = thingAt(event.target, options);
    if (!thing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (store.read().things.some(held => held.key === thing.key)) store.remove(thing.key);
    else store.add([thing]);
  };
  // A press on a thing while picking must not start the page's own drag or focus, only the pick.
  const onDown = (event: PointerEvent) => {
    skipClickAfterDrag = false;
    if (store.read().picking && event.button === 0 && elementOf(event.target)) event.preventDefault();
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && store.read().picking) store.setPicking(false); };
  const showPicking = () => {
    const { picking } = store.read();
    document.documentElement.toggleAttribute(pickingAttribute, picking);
    if (!picking) point(null);
  };

  const ruleOf = (element: Element) => options.rules.find(rule => element.matches(rule.selector));
  const marquee = mountMarqueeSelection(document.body, {
    enabled: () => store.read().picking,
    items: selectorOfAll,
    skip: `input,select,textarea,[role=menu],${options.ignore}`,
    idOf: (element: Element) => {
      const rule = ruleOf(element);
      return rule ? thingOf(element, rule, options)?.key ?? null : null;
    },
    onSelect: (_keys: string[], { elements }: { elements: Element[] }) => {
      skipClickAfterDrag = true;
      // A box over shareable rows takes those records, not the table's buttons, headings or other controls
      // whose bounds cross the same box. Without a record it can still pick ordinary parts of the screen.
      const records = [...new Set(elements.map(element => shareableAncestor(element, options.rules)?.element).filter((element): element is Element => Boolean(element)))];
      const candidates = records.length ? records : [...new Set(elements)];
      const innermost = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
      store.add(innermost.flatMap(element => {
        const rule = ruleOf(element);
        const thing = rule ? thingOf(element, rule, options) : null;
        return thing ? [thing] : [];
      }));
    },
  });

  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  const stopWatching = store.subscribe(showPicking);
  showPicking();
  return {
    pointed: () => thingAt(rightClicked, options),
    destroy() {
      marquee.destroy();
      stopWatching();
      point(null);
      document.documentElement.removeAttribute(pickingAttribute);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
    },
  };
}
