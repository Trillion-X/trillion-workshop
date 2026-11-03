// tools/page-critic/do-work/measure-rendered-frame.mjs
//
// The rendered frame check (F-1117): how the page sits in the browser at each width, read from what is actually drawn
// (the boxes of elements with their own text, pictures, controls and background pictures), on the first screen and over the whole page. One entry per
// rule id: screen_side_margins, lopsided_section, blank_stretch, no_first_screen_title, untitled_section and
// left_edge_crowding. Text too close to the browser's edge is the older edge_padding rule, not repeated here.
//
// Every threshold, selector and word is the rule row's (read-data/page-craft-rules.json); this file names none. The
// function is injected into the page as text (measure-page-craft.mjs), so it closes over nothing: what it needs from
// the shared readers is handed to it. No browser starts when this module is imported.
export function renderedFrameMeasures({ selectors, shown, words, vw, vh }) {
  const pageTop = () => window.scrollY;
  const seen = element => (element.checkVisibility ? element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : shown(element));
  // Text a screen reader alone is meant to hear (a 1px clipped box) draws nothing a person sees.
  const clippedAway = element => {
    for (let node = element, depth = 0; node && node !== document.body && depth < 4; node = node.parentElement, depth++) {
      const box = node.getBoundingClientRect();
      if ((box.width <= 2 || box.height <= 2) && getComputedStyle(node).overflow !== 'visible') return true;
    }
    return false;
  };
  const toPage = box => ({ left: box.left, right: box.right, top: box.top + pageTop(), bottom: box.bottom + pageTop() });
  // The box of every element inside `scope` that draws something (its own text, a picture, a control, a background
  // picture), in page coordinates, kept when a person could see it inside the browser's width.
  const ownText = element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
  // With `lines`, text is measured by its drawn lines rather than its element's box, so a short line in a wide block
  // shows where its words actually end.
  const ink = (scope, rule, { lines = false } = {}) => {
    const media = new Set(scope.querySelectorAll(selectors.frame_media));
    const boxes = [];
    for (const element of [...scope.querySelectorAll('*')].slice(0, rule.most_elements)) {
      const text = ownText(element);
      const draws = media.has(element) || text || (rule.count_background_images && /url\(/.test(getComputedStyle(element).backgroundImage));
      if (!draws || element.closest(selectors.frame_ignored) || !seen(element) || clippedAway(element)) continue;
      if (lines && text && !media.has(element)) {
        for (const node of element.childNodes) {
          if (node.nodeType !== 3 || !node.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const box of range.getClientRects()) if (box.width > 0 && box.height > 0) boxes.push(toPage(box));
        }
        continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width > 2 && box.height > 2) boxes.push(toPage(box));
    }
    return boxes.filter(box => box.right > 0 && box.left < vw);
  };
  const union = boxes => ({ left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)), top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)) });
  const rectOf = box => ({ x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.right - box.left), height: Math.round(box.bottom - box.top) });

  return {
    // The page's left and right content margins, on the first screen and over the whole page: too small, or lopsided.
    screen_side_margins: rule => {
      const everything = ink(document.body, rule).filter(box => box.right - box.left < vw * rule.full_bleed_fraction);
      const scopes = { first_screen: everything.filter(box => box.top < pageTop() + vh), whole_page: everything };
      return Object.entries(scopes).flatMap(([scope, boxes]) => {
        if (!boxes.length) return [];
        const content = union(boxes);
        const left = Math.round(Math.max(0, content.left));
        const right = Math.round(Math.max(0, vw - content.right));
        const values = { scope: rule.scope_words[scope], left, right, min_px: rule.min_px, max_difference_px: rule.max_difference_px };
        if (Math.min(left, right) < rule.min_px) return [{ values: { ...values, kind: 'small' }, rect: rectOf(content) }];
        if (Math.abs(left - right) > rule.max_difference_px) return [{ values: { ...values, kind: 'lopsided' }, rect: rectOf(content) }];
        return [];
      });
    },
    // A wide section whose drawn content sits heavily to one side of it.
    lopsided_section: rule => [...document.querySelectorAll(selectors.frame_sections)].filter(shown).map(section => {
      const box = section.getBoundingClientRect();
      if (box.width < rule.min_section_px) return null;
      const boxes = ink(section, rule, { lines: true });
      if (!boxes.length) return null;
      const content = union(boxes);
      const left = Math.round(content.left - box.left);
      const right = Math.round(box.right - content.right);
      const share = (content.right - content.left) / box.width;
      if (share >= rule.max_content_fraction || Math.abs(left - right) / box.width <= rule.max_imbalance) return null;
      return { values: { text: words(section).slice(0, 60), side: rule.side_words[left < right ? 'left' : 'right'], left, right }, element: section };
    }),
    // A run of the page, top to bottom, taller than the row allows with nothing drawn in it.
    blank_stretch: rule => {
      const boxes = ink(document.body, rule).sort((a, b) => a.top - b.top);
      const most = Math.round(vh * rule.max_screens);
      const height = document.documentElement.scrollHeight;
      const found = [];
      let reached = 0;
      for (const box of [...boxes, { top: height, bottom: height }]) {
        const gap = Math.round(box.top - reached);
        if (gap > most) found.push({ values: { px: gap, from: Math.round(reached), max_px: most }, rect: { x: 0, y: Math.round(reached), width: vw, height: gap } });
        reached = Math.max(reached, box.bottom);
      }
      return found;
    },
    // The first screen names no title: no top-level heading and no text as large as a title.
    no_first_screen_title: rule => {
      const onFirstScreen = element => { const box = element.getBoundingClientRect(); return box.top + pageTop() < vh && box.bottom > 0; };
      const titled = [...document.querySelectorAll(selectors.frame_titles)].some(element => seen(element) && words(element) && onFirstScreen(element));
      const large = titled || [...document.body.querySelectorAll('*')].some(element => ownText(element) && !element.closest(selectors.frame_ignored) && parseFloat(getComputedStyle(element).fontSize) >= rule.min_title_px && seen(element) && onFirstScreen(element));
      return titled || large ? [] : [{ values: { fold: vh, min_px: rule.min_title_px }, element: null }];
    },
    // A section with a good deal to read and no heading of its own.
    untitled_section: rule => [...document.querySelectorAll(selectors.frame_sections)].filter(shown).map(section => {
      const text = words(section);
      if (text.split(' ').filter(Boolean).length < rule.min_words) return null;
      if ([...section.querySelectorAll(selectors.frame_section_titles)].some(heading => seen(heading) && words(heading))) return null;
      return { values: { text: text.slice(0, 60), min_words: rule.min_words }, element: section };
    }),
    // Many blocks of text pressed against the left edge while the right side keeps its room.
    left_edge_crowding: rule => {
      const blocks = [...document.querySelectorAll(selectors.text)].filter(element => shown(element) && ownText(element) && !element.closest(selectors.frame_ignored)).map(element => element.getBoundingClientRect());
      const left = blocks.filter(box => box.left >= 0 && box.left < rule.within_px);
      const right = blocks.filter(box => box.right <= vw && box.right > vw - rule.within_px);
      if (left.length < rule.min_count || right.length >= left.length * rule.max_right_share) return [];
      return [{ values: { count: left.length, within_px: rule.within_px }, rect: rectOf(union(left.map(toPage))) }];
    },
  };
}
