// parts/screen-matrix/in-page.mjs
//
// PURPOSE
//   The functions that run INSIDE the page under test (check-screens.mjs hands each to page.evaluate, which sends its
//   source, so every function here is self-contained: it names nothing outside itself). They only read: the text a
//   person can see with the colours, boxes and clipping around it, and, for the pictures a check takes, the pixels
//   behind and inside a text box. Nothing here knows a page, a width or a mode; thresholds arrive as `config`.
//
// SHAPE
//   readPageFacts(config) -> { innerWidth, scrollWidth, widest: [{ selector, right }] }
//   readWindow(config)    -> { items, pending, covered }   the visible text whose middle is in the window now, once each
//                            per `config.pass`; an item is { mark, selector, text, colour, ground, complex, pixels, box,
//                            fontSize, fontWeight, fontFamily, fontKey, large, svg, clipped, outside, scrolls, ... }
//   samplePixels({ png, boxes }) -> [{ ground, best, ink, total, inkColour }]   read in a plain page, never the page under test
export function readPageFacts(config) {
  const root = document.documentElement;
  const viewWidth = config.width ?? innerWidth;
  const describe = element => {
    const parts = [];
    for (let at = element; at && at.nodeType === 1 && parts.length < 3; at = at.parentElement) {
      const id = at.id ? `#${at.id}` : '';
      const classes = id ? '' : [...at.classList].slice(0, 2).map(name => `.${name}`).join('');
      parts.unshift(`${at.tagName.toLowerCase()}${id}${classes}`);
    }
    return parts.join(' > ');
  };
  const widest = [];
  if (root.scrollWidth > viewWidth + config.tolerance_px) {
    const wide = [...document.body.querySelectorAll('*')].map(element => ({ element, right: element.getBoundingClientRect().right }))
      .filter(row => row.right > viewWidth + config.tolerance_px && !getComputedStyle(row.element).position.match(/fixed/))
      .sort((a, b) => b.right - a.right);
    for (const row of wide) {
      if (widest.length >= 3) break;
      if (widest.some(kept => kept.element.contains(row.element) || row.element.contains(kept.element))) continue;
      widest.push(row);
    }
  }
  return { innerWidth, scrollWidth: root.scrollWidth, widest: widest.map(row => ({ selector: describe(row.element), right: Math.round(row.right) })) };
}

export function readWindow(config) {
  const state = (window.__screenMatrix ??= { pass: null, done: new WeakSet(), marks: new WeakMap(), byMark: new Map(), count: 0, centered: new WeakSet(), want: null });
  if (state.pass !== config.pass) { state.pass = config.pass; state.done = new WeakSet(); state.centered = new WeakSet(); state.want = null; }
  const tol = config.tolerance_px;
  const viewWidth = config.width ?? innerWidth;
  const styles = new Map();
  const style = element => { let kept = styles.get(element); if (!kept) { kept = getComputedStyle(element); styles.set(element, kept); } return kept; };
  const parentOf = element => element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);

  // ---- colours: a computed colour as [r, g, b, alpha] ---------------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const paintbox = canvas.getContext('2d', { willReadFrequently: true });
  const colours = new Map();
  const parse = value => {
    if (colours.has(value)) return colours.get(value);
    let rgba;
    const legacy = /^rgba?\(([^)]+)\)$/.exec(value);
    if (legacy) {
      const [r, g, b, a] = legacy[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      rgba = [r, g, b, a ?? 1];
    } else {
      paintbox.clearRect(0, 0, 1, 1);
      paintbox.fillStyle = '#000';
      paintbox.fillStyle = value;
      paintbox.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paintbox.getImageData(0, 0, 1, 1).data;
      rgba = [r, g, b, a / 255];
    }
    colours.set(value, rgba);
    return rgba;
  };
  const over = (base, top) => base.map((channel, n) => top[n] * top[3] + channel * (1 - top[3]));
  const mix = (base, top, share) => base.map((channel, n) => channel * (1 - share) + top[n] * share);
  // What is seen at the end of a chain of surfaces (outermost first): each paints its colour over what is behind it, and a
  // surface with opacity blends itself and everything on it with what is behind, which is how the browser draws a group.
  const paint = (levels, at, base, top) => {
    if (at === levels.length) return top ? over(base, top) : base;
    const { colour, opacity } = levels[at];
    const here = colour[3] > 0 ? over(base, colour) : base;
    const inner = paint(levels, at + 1, here, top);
    return opacity < 1 ? mix(base, inner, opacity) : inner;
  };
  // The page's own colour where nothing paints one: the canvas the browser draws under it in this scheme and mode.
  // It only changes with the colour scheme and forced colours, so it is measured once for each: adding and removing a node would make the next box read lay the whole page out again.
  const canvasKey = `${getComputedStyle(document.documentElement).colorScheme}|${matchMedia('(forced-colors: active)').matches}`;
  state.canvas ??= new Map();
  if (!state.canvas.has(canvasKey)) {
    const sample = document.createElement('div');
    sample.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:Canvas;visibility:hidden';
    document.documentElement.append(sample);
    state.canvas.set(canvasKey, parse(getComputedStyle(sample).backgroundColor).slice(0, 3));
    sample.remove();
  }
  const canvasColour = state.canvas.get(canvasKey);

  const describe = element => {
    const parts = [];
    for (let at = element; at && at.nodeType === 1 && parts.length < 4; at = parentOf(at)) {
      const id = at.id ? `#${at.id}` : '';
      const classes = id ? '' : [...at.classList].slice(0, 2).map(name => `.${String(name).slice(0, 40)}`).join('');
      parts.unshift(`${at.tagName.toLowerCase()}${id}${classes}`);
    }
    return parts.join(' > ');
  };
  const painted = element => {
    const own = style(element);
    if (own.visibility !== 'visible') return false;
    if (/^(path|rect|circle|ellipse|polygon)$/.test(element.localName)) return own.fill !== 'none' && Number(own.fillOpacity) > 0.1 && Number(own.opacity) > 0.1;
    return parse(own.backgroundColor)[3] > 0.1 || own.backgroundImage !== 'none' || /^(IMG|VIDEO|CANVAS|PICTURE)$/.test(element.tagName);
  };
  // Asked once per element in a window: every text under the same card asks it of the same ancestors.
  const decoratedKept = new Map();
  const decorated = element => {
    let kept = decoratedKept.get(element);
    if (kept === undefined) {
      kept = ['::before', '::after'].some(pseudo => {
        const own = getComputedStyle(element, pseudo);
        return own.content !== 'none' && own.content !== 'normal' && (own.backgroundImage !== 'none' || parse(own.backgroundColor)[3] > 0.1) && /absolute|fixed/.test(own.position);
      });
      decoratedKept.set(element, kept);
    }
    return kept;
  };
  const markOf = element => {
    let mark = state.marks.get(element);
    // The attribute is written after the walk: a write between two reads would make the next read lay the page out again.
    if (mark === undefined) { mark = state.count += 1; state.marks.set(element, mark); state.byMark.set(mark, new WeakRef(element)); marked.push([element, mark]); }
    return mark;
  };

  const items = [];
  const marked = [];
  let pending = 0;
  let covered = 0;
  const walk = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) visit(node);
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) walk(element.shadowRoot);
  };
  const visit = node => {
    if (state.done.has(node) || !node.nodeValue.trim()) return;
    const element = node.parentElement;
    if (!element || element.closest('script,style,noscript,template,title,head,[hidden]')) { state.done.add(node); return; }
    // Text of an element that starts well below the window is for a later window; one box read says so without measuring its text.
    if (!config.everywhere && element.getBoundingClientRect().top > innerHeight + 300) { pending += 1; return; }
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) { state.done.add(node); return; }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    if (!rects.length) { state.done.add(node); return; }
    const box = { left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)), right: Math.max(...rects.map(r => r.right)), bottom: Math.max(...rects.map(r => r.bottom)) };
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
    // Nothing a person sees: a pixel-sized box (the visually hidden text), or text left of or above the page, where no one scrolls.
    if (box.width <= 1.5 || box.height <= 1.5 || box.right <= 0 || box.bottom + scrollY <= 0) { state.done.add(node); return; }
    const middleY = (box.top + box.bottom) / 2;
    const middleX = (box.left + box.right) / 2;
    if (middleY < 0) return;
    if (middleY >= innerHeight && !config.everywhere) { pending += 1; return; }

    const own = style(element);
    const svg = element instanceof SVGElement;
    // Clipping and scrolling around the text: what cuts it, whether it is all cut away, and what it may leave through.
    let clipped = null;
    let hiddenAway = false;
    let scroller = false;
    // An ancestor that scrolls an axis moves the text there, so what an outer ancestor then cuts at the same edge is a scroll, not a defect.
    let scrollsInX = false;
    let scrollsInY = false;
    const clamps = [];
    let ellipsed = false;
    for (let at = element; at && at !== document.documentElement; at = parentOf(at)) {
      const around = style(at);
      // Visually hidden text (clip: rect(0 0 0 0), clip-path: inset(50%)) is for readers, not for eyes.
      if (/^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(around.clip) || /^inset\((50|100)%\)$/.test(around.clipPath)) { state.done.add(node); return; }
      if (around.webkitLineClamp && around.webkitLineClamp !== 'none') clamps.push(at);
      const hidesX = around.overflowX === 'hidden' || around.overflowX === 'clip';
      const hidesY = around.overflowY === 'hidden' || around.overflowY === 'clip';
      if (around.overflowX === 'auto' || around.overflowX === 'scroll') scroller = true;
      const scrollsX = around.overflowX === 'auto' || around.overflowX === 'scroll';
      const scrollsY = around.overflowY === 'auto' || around.overflowY === 'scroll';
      const cutsX = hidesX && !scrollsInX;
      const cutsY = hidesY && !scrollsInY;
      scrollsInX ||= scrollsX;
      scrollsInY ||= scrollsY;
      if (!hidesX && !hidesY && !scrollsX && !scrollsY) continue;
      if (hidesX) scroller = true;
      const area = at.getBoundingClientRect();
      const left = area.left + at.clientLeft;
      const top = area.top + at.clientTop;
      const right = left + at.clientWidth;
      const bottom = top + at.clientHeight;
      if (box.right <= left || box.left >= right || box.bottom <= top || box.top >= bottom) { hiddenAway = hidesX || hidesY ? 'clipped' : 'scrolled'; break; }
      // Text half inside a scroller (its edge fades or cuts it) is read once the scroller has brought it to the middle.
      if (scrollsY && !config.everywhere && !state.centered.has(element) && at.scrollHeight > at.clientHeight + 2 && (box.top < top - tol || box.bottom > bottom + tol)) {
        state.centered.add(element); state.want = element; pending += 1; return;
      }
      if (!(hidesX || hidesY)) continue;
      const cutX = cutsX && (box.left < left - tol || box.right > right + tol);
      const cutY = cutsY && (box.top < top - tol || box.bottom > bottom + tol);
      // A nearer ancestor that already ends the line with an ellipsis shortens what an outer ancestor can see of it.
      const ellipsis = ellipsed || [element, at].some(holder => style(holder).textOverflow === 'ellipsis');
      if (hidesX && around.textOverflow === 'ellipsis') ellipsed = true;
      if ((cutX || cutY) && !ellipsis && !clamps.length && !clipped) {
        clipped = { by: describe(at), text: [box.left, box.top, box.right, box.bottom].map(Math.round), box: [left, top, right, bottom].map(Math.round) };
      }
    }
    // Text a scroller keeps out of sight now is read when it is scrolled to; text cut away for good is not on the screen at all.
    if (hiddenAway) { if (hiddenAway === 'clipped') state.done.add(node); return; }
    const fullyOffRight = box.left >= viewWidth;
    if (fullyOffRight && !scroller) { state.done.add(node); return; }
    const outside = !scroller && ((box.right > viewWidth + tol && box.left < viewWidth) || (box.left < -tol && box.right > 0));
    // The text's own element hides what overflows it (overflow hidden/clip) with nothing saying so (no ellipsis, no clamp).
    let scrolls = null;
    if ((own.overflowX === 'hidden' || own.overflowX === 'clip' || own.overflowY === 'hidden' || own.overflowY === 'clip') && !svg
      && own.textOverflow !== 'ellipsis' && !(own.webkitLineClamp && own.webkitLineClamp !== 'none')) {
      const wide = element.scrollWidth > element.clientWidth + tol && (own.overflowX === 'hidden' || own.overflowX === 'clip');
      const tall = element.scrollHeight > element.clientHeight + tol && (own.overflowY === 'hidden' || own.overflowY === 'clip');
      if ((wide || tall) && element.clientWidth > 0) scrolls = `scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth}`.replace(/.*/, wide ? `scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth}` : `scrollHeight ${element.scrollHeight} > clientHeight ${element.clientHeight}`);
    }

    // What is in front of the text and what is behind it that is not one of its own surfaces.
    let underlay = null;
    if (middleX >= 0 && middleX < viewWidth) {
      const stack = document.elementsFromPoint(middleX, middleY);
      const at = stack.findIndex(other => other === element || element.contains(other) || other.contains(element));
      if (at > 0 && stack.slice(0, at).some(painted)) { covered += 1; pending += 1; return; }
      if (at >= 0) {
        const behind = stack.slice(at + 1).find(other => !other.contains(element) && painted(other));
        if (behind) underlay = `behind it: ${describe(behind)}`;
      }
    }

    // Surfaces outermost first, with any reason the colour behind the text cannot be read from styles alone.
    const levels = [];
    let complex = svg ? 'svg text' : underlay;
    let clipsToText = false;
    let groundSelector = null;
    for (let at = element; at; at = parentOf(at)) {
      const around = style(at);
      if (!groundSelector && parse(around.backgroundColor)[3] >= 0.5) groundSelector = describe(at);
      const image = around.backgroundImage !== 'none';
      if (image && (around.backgroundClip === 'text' || around.webkitBackgroundClip === 'text')) clipsToText = true;
      else if (image) complex ??= `background-image on ${describe(at)}`;
      if (around.backdropFilter && around.backdropFilter !== 'none') complex ??= `backdrop-filter on ${describe(at)}`;
      if (around.mixBlendMode !== 'normal') complex ??= `mix-blend-mode on ${describe(at)}`;
      if (at !== element && at.getRootNode() === document && decorated(at)) complex ??= `decorated surface ${describe(at)}`;
      levels.unshift({ colour: parse(around.backgroundColor), opacity: Number(around.opacity) });
    }
    // Forced colours repaint text with `color` and leave -webkit-text-fill-color as the page wrote it, so the fill is read from `color` there.
    const forcedColours = matchMedia('(forced-colors: active)').matches && own.forcedColorAdjust !== 'none';
    const textFill = svg ? own.fill : (forcedColours ? own.color : (own.webkitTextFillColor || own.color));
    let colour = null;
    if (!svg || /^(rgb|color|#)/.test(textFill)) colour = parse(textFill);
    if (colour && svg) colour = [colour[0], colour[1], colour[2], colour[3] * Number(own.fillOpacity)];
    let fillKnown = !!colour && colour[3] > 0;
    if (colour && colour[3] === 0 && !clipsToText && !svg) { state.done.add(node); return; }
    if (clipsToText) { fillKnown = false; complex ??= 'text filled by its background'; }
    if (svg && !fillKnown) complex ??= 'svg paint';
    const stroke = svg ? (own.stroke !== 'none' && Number.parseFloat(own.strokeWidth) > 0 ? `${own.stroke} ${own.strokeWidth}` : null)
      : (Number.parseFloat(own.webkitTextStrokeWidth) > 0 ? `${own.webkitTextStrokeColor} ${own.webkitTextStrokeWidth}` : null);
    const risky = complex || stroke || (own.paintOrder && own.paintOrder !== 'normal') || (own.textShadow && own.textShadow !== 'none') || own.mask !== 'none' || own.clipPath !== 'none';
    const fontSize = Number.parseFloat(own.fontSize);
    const weight = Number(own.fontWeight) || 400;
    const seenColour = colour && fillKnown ? colour : null;
    // What decides the fonts a platform draws this element's text with: its font properties and the characters of all its own text.
    const ownText = [...element.childNodes].filter(child => child.nodeType === 3).map(child => child.nodeValue).join('');
    const fontKey = [own.fontFamily, own.fontWeight, own.fontStyle, own.fontStretch, own.textTransform, own.fontVariant, own.fontFeatureSettings, own.fontSynthesis, own.fontVariationSettings, element.closest('[lang]')?.getAttribute('lang') ?? ''].join('|')
      + `|${[...new Set(ownText.replace(/\s+/g, ' '))].sort().join('')}`;
    state.done.add(node);
    items.push({
      mark: markOf(element),
      selector: describe(element),
      text: node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 80),
      colour: seenColour,
      colourText: textFill,
      groundSelector,
      computed: seenColour ? paint(levels, 0, canvasColour, null).map(Math.round) : null,
      ground: seenColour && !complex ? paint(levels, 0, canvasColour, null).map(Math.round) : null,
      observed: seenColour && !complex ? paint(levels, 0, canvasColour, seenColour).map(Math.round) : null,
      complex,
      pixels: complex ?? (risky ? 'paints beyond its colour' : null),
      stroke,
      box: { left: box.left, top: box.top, width: box.width, height: box.height },
      fontSize,
      fontWeight: weight,
      fontFamily: own.fontFamily,
      fontKey,
      large: fontSize >= config.large_px || (fontSize >= config.large_bold_px && weight >= config.bold_weight),
      svg,
      clipped,
      outside: outside ? [Math.round(box.left), Math.round(box.right), viewWidth] : null,
      scrolls,
      disabled: !!element.closest(':disabled,[aria-disabled="true"]'),
    });
  };
  walk(document.body);
  for (const [element, mark] of marked) element.setAttribute('data-screen-matrix', String(mark));
  return { items, pending, covered };
}

export async function samplePixels({ png, boxes, pad }) {
  const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const sheet = new OffscreenCanvas(bitmap.width, bitmap.height);
  const draw = sheet.getContext('2d', { willReadFrequently: true });
  draw.drawImage(bitmap, 0, 0);
  const everything = draw.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const linear = Array.from({ length: 256 }, (_, n) => { const c = n / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const light = (r, g, b) => 0.2126 * linear[r] + 0.7152 * linear[g] + 0.0722 * linear[b];
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const at = (x, y) => (y * bitmap.width + x) * 4;
  return boxes.map(box => {
    const left = Math.max(0, Math.floor(box.left));
    const top = Math.max(0, Math.floor(box.top));
    const right = Math.min(bitmap.width, Math.ceil(box.left + box.width));
    const bottom = Math.min(bitmap.height, Math.ceil(box.top + box.height));
    if (right <= left || bottom <= top) return null;
    // The ground behind the glyphs: the commonest colour in a ring just outside the box, where only the surface is.
    const buckets = new Map();
    const take = (x, y) => {
      const i = at(x, y);
      const key = ((everything[i] >> 3) << 10) | ((everything[i + 1] >> 3) << 5) | (everything[i + 2] >> 3);
      const found = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      found.n += 1; found.r += everything[i]; found.g += everything[i + 1]; found.b += everything[i + 2];
      buckets.set(key, found);
    };
    const outerLeft = Math.max(0, left - pad - 2), outerTop = Math.max(0, top - pad - 2);
    const outerRight = Math.min(bitmap.width, right + pad + 2), outerBottom = Math.min(bitmap.height, bottom + pad + 2);
    const innerLeft = left - pad, innerTop = top - pad, innerRight = right + pad, innerBottom = bottom + pad;
    for (let y = outerTop; y < outerBottom; y += 1) for (let x = outerLeft; x < outerRight; x += 1) {
      if (x >= innerLeft && x < innerRight && y >= innerTop && y < innerBottom) continue;
      take(x, y);
    }
    let ring = true;
    if (!buckets.size) { ring = false; for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) take(x, y); }
    const common = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
    const ground = [Math.round(common.r / common.n), Math.round(common.g / common.n), Math.round(common.b / common.n)];
    const groundLight = light(...ground);
    let best = 1;
    let ink = 0;
    let total = 0;
    let inkColour = ground;
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const i = at(x, y);
      const seen = ratio(groundLight, light(everything[i], everything[i + 1], everything[i + 2]));
      total += 1;
      if (seen >= 1.5) ink += 1;
      if (seen > best) { best = seen; inkColour = [everything[i], everything[i + 1], everything[i + 2]]; }
    }
    return { ground, best, ink, total, inkColour, ring };
  });
}
