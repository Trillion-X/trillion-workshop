// tools/page-critic/do-work/measure-page-rules.mjs
//
// Rendered-page rules written as one checkable line each (F-1149): Tab order (tab_order_positive, tab_order_backwards),
// heading order (heading_skip, heading_h1_count) and page metadata (page_title, page_lang, page_description,
// page_viewport). Controls with no accessible name are the older control_name rule (read from Chromium's accessibility
// tree), not repeated here.
//
// Every threshold, selector and word is the rule row's (read-data/page-craft-rules.json); this file names none. The
// function is injected into the page as text (measure-page-craft.mjs), so it closes over nothing: what it needs from
// the shared readers is handed to it. No browser starts when this module is imported.
export function pageRuleMeasures({ selectors, shown, words }) {
  const label = element => (element.getAttribute('aria-label') || words(element) || element.getAttribute('title') || element.getAttribute('name') || element.getAttribute('href') || element.tagName.toLowerCase()).slice(0, 60);
  const level = element => Number(element.getAttribute('aria-level')) || Number(element.tagName.slice(1)) || 2;
  const stops = () => [...document.querySelectorAll(selectors.tab_stops)].filter(element => shown(element) && !element.disabled && !element.closest('[inert]') && element.tabIndex >= 0);
  const content = selector => (document.querySelector(selector)?.getAttribute('content') || '').trim();
  return {
    // A tabindex above zero takes the element out of the page's own order.
    tab_order_positive: () => stops().filter(element => element.tabIndex > 0).map(element => ({ values: { text: label(element), tabindex: element.tabIndex }, element })),
    // The order Tab visits (positive tabindex first, then the page's order) jumps back up the screen.
    tab_order_backwards: rule => {
      const order = stops().map((element, at) => ({ element, at })).sort((a, b) => ((a.element.tabIndex || Infinity) - (b.element.tabIndex || Infinity)) || a.at - b.at).map(item => item.element);
      const top = element => element.getBoundingClientRect().top + window.scrollY;
      return order.slice(1).map((element, at) => {
        const px = Math.round(top(order[at]) - top(element));
        return px > rule.max_jump_up_px ? { values: { text: label(element), from: label(order[at]), px, max_px: rule.max_jump_up_px }, element } : null;
      });
    },
    // A heading more than one level below the heading before it.
    heading_skip: () => {
      const headings = [...document.querySelectorAll(selectors.heading_levels)].filter(shown);
      return headings.slice(1).map((element, at) => {
        const before = level(headings[at]);
        return level(element) > before + 1 ? { values: { text: words(element).slice(0, 60), level: level(element), previous: before }, element } : null;
      });
    },
    // No top-level heading, or more than the row allows.
    heading_h1_count: rule => {
      const tops = [...document.querySelectorAll(selectors.top_headings)].filter(shown);
      if (!tops.length) return [{ values: { kind: 'none', count: 0 }, element: null }];
      return tops.length > rule.most ? [{ values: { kind: 'many', count: tops.length, most: rule.most, text: words(tops[rule.most]).slice(0, 60) }, element: tops[rule.most] }] : [];
    },
    page_title: rule => (document.title.trim().length < rule.min_chars ? [{ values: { min_chars: rule.min_chars }, element: null }] : []),
    page_lang: () => ((document.documentElement.getAttribute('lang') || '').trim() ? [] : [{ values: {}, element: null }]),
    page_description: rule => (content(selectors.meta_description).length < rule.min_chars ? [{ values: { min_chars: rule.min_chars }, element: null }] : []),
    page_viewport: rule => (new RegExp(rule.content_pattern, 'i').test(content(selectors.meta_viewport)) ? [] : [{ values: {}, element: null }]),
  };
}
