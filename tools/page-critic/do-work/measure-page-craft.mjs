import { controlDomObservationExpression } from './collect-control-names.mjs';
import { renderedLabelSizeMeasurements } from './measure-rendered-label-size.mjs';

// Shared rendered-page craft measurements for the critic and release screen matrix.
// No browser or service starts when this module is imported.
// Small readers shared by every in-page function (the page itself and the owner element of each embedded frame).
export const pageCraftHelpers = String.raw`
  const controlDomObservation = ${controlDomObservationExpression};
  const renderedLabelSizeMeasurements = ${renderedLabelSizeMeasurements.toString()};
  const shown = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0; };
  const words = element => (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
  const where = element => { const box = element.getBoundingClientRect(); return { x: Math.round(box.left), y: Math.round(box.top + window.scrollY), width: Math.round(box.width), height: Math.round(box.height) }; };
  // A short selector a person can find the element by: up to four levels, the last class, the id when it looks hand-written.
  const pathOf = element => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      if (node === document.body) { parts.unshift('body'); break; }
      let part = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}|[0-9a-f]{8,}/i.test(node.id)) { parts.unshift(part + '#' + node.id); break; }
      const named = [...node.classList].filter(name => /^[a-z][\w-]*$/i.test(name) && name.length < 50);
      if (named.length) part += '.' + named[named.length - 1];
      const same = node.parentElement ? [...node.parentElement.children].filter(other => other.tagName === node.tagName) : [];
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
`;

// Refuse a control-name result when the browser's AX evidence changed while the
// in-page measurements ran. Geometry is intentionally excluded: scrolling or
// animation can move a control without changing its identity or computed name.
export function bindControlNameEvidence(measurement, before, after) {
  if (!measurement || !Array.isArray(measurement.found) || !Array.isArray(before) || !Array.isArray(after)) {
    throw new TypeError('control_name evidence binding requires a measurement and two AX snapshots');
  }
  const grouped = rows => {
    const map = new Map();
      for (const row of rows) {
      if (!Number.isInteger(row?.backendNodeId)) throw new TypeError('control_name AX snapshot has no backend node identity');
      if (row.shown === false) continue;
      const matches = map.get(row.backendNodeId) ?? [];
      matches.push(row);
      map.set(row.backendNodeId, matches);
    }
    return map;
  };
  const oldByNode = grouped(before);
  const newByNode = grouped(after);
  const changed = [];
  for (const backendNodeId of new Set([...oldByNode.keys(), ...newByNode.keys()])) {
    const oldRows = oldByNode.get(backendNodeId) ?? [];
    const newRows = newByNode.get(backendNodeId) ?? [];
    const sameEvidence = oldRows.length === 1 && newRows.length === 1
      && ['role', 'name', 'state', 'reason', 'shown', 'identitySelector'].every(key => (oldRows[0][key] ?? null) === (newRows[0][key] ?? null));
    if (!sameEvidence) changed.push(...(newRows.length ? newRows : oldRows));
  }
  if (!changed.length) return measurement;

  const selectors = new Set(changed.map(row => row.identitySelector ?? row.selector).filter(Boolean));
  const found = measurement.found.filter(item => item.rule !== 'control_name' || !selectors.has(item.identitySelector ?? item.selector));
  const emitted = new Set();
  for (const row of changed) {
    const selector = row.structuralSelector ?? row.selector ?? null;
    const key = `${selector ?? ''}\0${row.role ?? 'control'}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const role = row.role ?? 'control';
    const text = `${role} control`;
    found.push({
      rule: 'control_name',
      values: {kind: 'unavailable', role, text, reason: 'accessibility evidence changed during measurement'},
      text,
      selector,
      identitySelector: row.identitySelector ?? null,
      displaySelector: row.selector ?? null,
      rect: null,
    });
  }
  return {...measurement, found};
}

// What the page itself measures, run inside it: one function per rule id, each answering [{ values, text, rect }].
// It reads only the page, the rule row and the selectors. The same function runs inside each embedded frame
// (through an isolated DevTools world, so a frame of another origin is read too) for the rules that say `in_frames`.
export const pageCraftMeasures = String.raw`(async ({ rules, selectors, freshDays, now, widthId, controlNames = [] }) => {
  ${pageCraftHelpers}
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const all = selector => [...document.querySelectorAll(selector)].filter(shown);
  const ownText = element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
  let renderedLabels = null;
  const MEASURES = {
    rendered_label_size: rule => {
      const rows = renderedLabelSizeMeasurements(rule);
      renderedLabels = rows.map(row => ({...row.values, selector:pathOf(row.element)}));
      return rows.filter(row => row.values.kind !== 'measured');
    },
    control_name: rule => {
      const byIdentity = new Map();
      for (const item of controlNames) byIdentity.set(item.identitySelector, [...(byIdentity.get(item.identitySelector) || []), item]);
      const candidates = all(selectors.control_name_candidates);
      const identified = candidates.map(element => ({ element, ...controlDomObservation(element) })).filter(item => item.shown);
      const candidateIdentities = new Map();
      for (const item of identified) candidateIdentities.set(item.identitySelector, (candidateIdentities.get(item.identitySelector) || 0) + 1);
      return identified.flatMap(({ element, selector: displaySelector, identitySelector, structuralSelector }) => {
        const matches = byIdentity.get(identitySelector) || [];
        const ambiguousPath = candidateIdentities.get(identitySelector) > 1;
        const item = matches.length === 1 ? matches[0] : null;
        const role = item?.role || 'control';
        const text = role + ' control';
        const evidence = { element, identitySelector, selector: structuralSelector, displaySelector };
        if (ambiguousPath || !item || item.state !== 'available') return [{ values: { kind: 'unavailable', role, text, reason: ambiguousPath || matches.length > 1 ? 'ambiguous DOM identity' : item?.reason || 'no matching AX record' }, ...evidence }];
        return String(item.name ?? '').trim() ? [] : [{ values: { kind: 'unnamed', role, text }, ...evidence }];
      });
    },
    heading_measure: rule => all(selectors.headings).map(element => {
      const size = parseFloat(getComputedStyle(element).fontSize) || 16;
      const ch = Math.round(element.getBoundingClientRect().width / (size * 0.5));
      return ch > rule.max_ch && words(element).length > rule.max_ch ? { values: { ch, max_ch: rule.max_ch }, element } : null;
    }),
    body_width: rule => all(selectors.body_text).map(element => {
      const fraction = element.getBoundingClientRect().width / vw;
      return fraction > rule.max_fraction && words(element).length > 80 ? { values: { percent: Math.round(fraction * 100), max_percent: Math.round(rule.max_fraction * 100) }, element } : null;
    }),
    eyebrow: rule => all(selectors.headings).map(heading => {
      let before = heading.previousElementSibling;
      while (before && !shown(before)) before = before.previousElementSibling;
      if (!before || !before.matches(selectors.eyebrow_candidates)) return null;
      const text = words(before);
      const style = getComputedStyle(before);
      const size = parseFloat(style.fontSize);
      const small = size < parseFloat(getComputedStyle(heading).fontSize) * rule.smaller_than_heading;
      const gap = heading.getBoundingClientRect().top - before.getBoundingClientRect().bottom;
      const ids = [before, ...before.querySelectorAll('[id]')].map(node => node.id).filter(Boolean);
      const referenced = ids.length && [...document.querySelectorAll('[aria-describedby], [aria-labelledby]')].some(node =>
        ['aria-describedby', 'aria-labelledby'].some(name => (node.getAttribute(name) || '').split(/\s+/).some(id => ids.includes(id))));
      if (referenced || before.matches(selectors.eyebrow_ignored) || before.querySelector(selectors.eyebrow_ignored)) return null;
      return text && text.split(' ').length <= rule.max_words && small && gap <= size * rule.max_gap_em ? { values: { text }, element: before } : null;
    }),
    inline_icon_scale: rule => all(selectors.inline_icon_actions).flatMap(element => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => {
        if (!node.textContent.trim() || node.parentElement.closest('svg, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        for (let parent = node.parentElement; parent && parent !== element; parent = parent.parentElement) {
          const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || (box.width <= 1 && box.height <= 1 && ['hidden','clip'].includes(style.overflow))) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }});
      if (text.nextNode() || !element.querySelector('svg')) return [];
      const passage = element.closest(selectors.inline_icon_context);
      if (!passage) return [];
      const font = parseFloat(getComputedStyle(passage).fontSize);
      const icon = element.querySelector('svg').getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const iconSize = Math.min(icon.width, icon.height);
      if (iconSize >= font * rule.min_font_fraction && Math.min(box.width, box.height) >= rule.min_target_px) return [];
      return [{ values: { text: words(passage).slice(0, 80), icon: Math.round(iconSize), font: Math.round(font), target: Math.round(Math.min(box.width, box.height)), min_target: rule.min_target_px }, element }];
    }),
    repeated_supporting_text: rule => {
      // Compare adjacent visible siblings, never a whole section whose text includes
      // the heading. Protect descriptions used by controls even if their words repeat.
      const described = new Set([...document.querySelectorAll('[aria-describedby], [aria-labelledby], [aria-errormessage]')]
        .flatMap(element => ['aria-describedby', 'aria-labelledby', 'aria-errormessage'].flatMap(name => (element.getAttribute(name) || '').split(/\s+/).filter(Boolean))));
      const normalized = element => words(element).normalize('NFKC').toLocaleLowerCase().replace(/[\s.!?:;,]+$/u, '');
      const isProtected = element => element.closest(selectors.supporting_text_ignored) || element.querySelector(selectors.supporting_text_controls)
        || [...described].some(id => { const target = document.getElementById(id); return target && (target === element || element.contains(target) || target.contains(element)); });
      const productionPatterns = (rule.production_patterns || []).map(pattern => new RegExp(pattern, 'i'));
      const headingFor = element => {
        let heading = element.previousElementSibling;
        while (heading && !shown(heading)) heading = heading.previousElementSibling;
        return heading?.matches(selectors.headings) ? heading : null;
      };
      const productionFindings = all(selectors.production_copy_text).flatMap(element => {
        if (isProtected(element) || element.querySelector(selectors.production_copy_text)) return [];
        const text = words(element);
        return productionPatterns.some(pattern => pattern.test(text))
          ? [{ values: { text, kind: 'production commentary' }, element }]
          : [];
      });
      const findings = all(selectors.supporting_text).flatMap(element => {
        if (isProtected(element) || element.querySelector(selectors.supporting_text)) return [];
        const text = words(element);
        if (productionPatterns.some(pattern => pattern.test(text))) {
          return [{ values: { text, kind: 'production commentary' }, element }];
        }
        const heading = headingFor(element);
        if (!heading) return [];
        const count = text.split(/\s+/).filter(Boolean).length;
        const hbox = heading.getBoundingClientRect(), box = element.getBoundingClientRect();
        const small = parseFloat(getComputedStyle(element).fontSize) < parseFloat(getComputedStyle(heading).fontSize) * rule.smaller_than_heading;
        const near = box.top - hbox.bottom <= parseFloat(getComputedStyle(heading).fontSize) * rule.max_gap_em;
        const redundant = count >= rule.min_words && normalized(element) === normalized(heading);
        const shortSecondary = count >= rule.min_words && count <= rule.short_max_words && small && near
          && !/[.!?]["')\]]*$/u.test(text);
        return redundant || shortSecondary ? [{ values: { text, kind: redundant ? 'repeated heading' : 'secondary caption' }, element }] : [];
      });
      return [...productionFindings, ...findings];
    },
    edge_padding: rule => all(selectors.text).filter(ownText).map(element => {
      const box = element.getBoundingClientRect();
      const px = Math.round(Math.min(box.left, vw - box.right));
      return px < rule.min_px && box.width < vw - 1 ? { values: { text: words(element).slice(0, 60), px, min_px: rule.min_px }, element } : null;
    }),
    overflow_outside_container: rule => all(selectors.overflowing).filter(element => !element.closest(selectors.overflow_ignored)).map(element => {
      const box = element.getBoundingClientRect();
      const container = element.parentElement.closest(selectors.containers);
      const px = Math.round(Math.max(box.right - vw, -box.left, container ? box.right - container.getBoundingClientRect().right : 0));
      return box.right > 0 && box.left < vw && px > rule.min_px && (!container || getComputedStyle(container).overflowX === 'visible') ? { values: { text: (words(element) || element.getAttribute('aria-label') || element.getAttribute('name') || element.tagName.toLowerCase()).slice(0, 60), px }, element } : null;
    }),
    broken_anchor: () => all(selectors.anchors).map(element => {
      const target = decodeURIComponent(element.getAttribute('href').slice(1));
      return target && !document.getElementById(target) && !document.getElementsByName(target).length ? { values: { text: words(element).slice(0, 60), target }, element } : null;
    }),
    card_cannot_open: () => all(selectors.cards).map(element => (element.matches(selectors.openers) || element.querySelector(selectors.openers) || element.closest(selectors.openers) || getComputedStyle(element).cursor !== 'pointer') ? null : { values: { text: words(element).slice(0, 60) }, element }),
    stale: rule => {
      if (!freshDays) return [];
      const dates = [...document.querySelectorAll(selectors.dates)].map(element => Date.parse(element.getAttribute('datetime'))).filter(Number.isFinite);
      if (!dates.length) return [];
      const newest = Math.max(...dates);
      const days = Math.floor((now - newest) / 86400000);
      return days > freshDays ? [{ values: { newest: new Date(newest).toISOString().slice(0, 10), days, max_days: freshDays }, element: null }] : [];
    },
    endless_scroll: rule => {
      const screens = Math.round(document.documentElement.scrollHeight / vh);
      return screens > rule.max_screens ? [{ values: { screens, max_screens: rule.max_screens }, element: null }] : [];
    },
    // Test or placeholder data a visitor can read: visible text and alt text matched against the rule's named patterns.
    test_data: rule => {
      const patterns = rule.patterns.map(pattern => ({ name: pattern.name, re: new RegExp(pattern.regex, (pattern.flags ?? 'i') + 'g') }));
      const hits = [];
      const check = (text, element, source) => {
        const spans = [];
        for (const pattern of patterns) {
          pattern.re.lastIndex = 0;
          const match = pattern.re.exec(text);
          if (!match || spans.some(([from, to]) => match.index < to && match.index + match[0].length > from)) continue;
          spans.push([match.index, match.index + match[0].length]);
          const from = Math.max(0, match.index - rule.context_chars);
          const text60 = (from > 0 ? '...' : '') + text.slice(from, match.index + match[0].length + rule.context_chars).trim();
          hits.push({ values: { kind: pattern.name, source, match: match[0].slice(0, 60), text: text60, selector: pathOf(element) }, element });
        }
      };
      // An element is read as one line when everything inside it runs inline, so a phrase split by <b> or <a> is still seen.
      const lineOf = element => [...element.children].every(child => getComputedStyle(child).display.startsWith('inline')) ? words(element) : [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim().replace(/\s+/g, ' ');
      for (const element of document.body.querySelectorAll('*')) {
        if (!ownText(element) || element.closest(selectors.test_data_ignored) || !shown(element)) continue;
        const line = lineOf(element);
        if (line) check(line, element, 'text');
      }
      for (const element of all(selectors.alt_text)) {
        const alt = (element.getAttribute('alt') || '').trim();
        if (alt) check(alt, element, 'alt text');
      }
      return hits;
    },
    // Two or more siblings (cards, list items, figures) titled the same once ids and hashes are taken away.
    duplicate_cards: rule => {
      const away = rule.normalize_away.map(source => new RegExp(source, 'gi'));
      const normal = title => { let text = title.toLowerCase(); for (const re of away) text = text.replace(re, ' '); return text.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); };
      const bigrams = text => { const pairs = new Map(); for (let at = 0; at < text.length - 1; at++) { const pair = text.slice(at, at + 2); pairs.set(pair, (pairs.get(pair) || 0) + 1); } return pairs; };
      const dice = (a, b) => {
        if (a === b) return 1;
        const left = bigrams(a); const right = bigrams(b); let common = 0;
        for (const [pair, count] of left) common += Math.min(count, right.get(pair) || 0);
        return (2 * common) / Math.max(1, a.length - 1 + b.length - 1);
      };
      const titleOf = item => {
        const named = [...item.querySelectorAll(selectors.card_titles)].find(element => shown(element) && words(element));
        return words(named || item).slice(0, rule.title_chars);
      };
      const groups = new Map();
      for (const item of all(selectors.card_items)) {
        if (item.closest(selectors.duplicates_ignored) || !item.parentElement) continue;
        const title = titleOf(item);
        if (normal(title).length < rule.min_title_chars) continue;
        groups.set(item.parentElement, [...(groups.get(item.parentElement) || []), { item, title, key: normal(title) }]);
      }
      const hits = [];
      for (const [parent, members] of groups) {
        const clusters = [];
        for (const member of members) {
          const cluster = clusters.find(other => dice(other[0].key, member.key) >= rule.min_similarity);
          if (cluster) cluster.push(member); else clusters.push([member]);
        }
        for (const cluster of clusters.filter(group => group.length > 1)) hits.push({ values: { text: cluster[0].title, count: cluster.length, selector: pathOf(cluster[1].item), first_selector: pathOf(cluster[0].item) }, element: cluster[1].item });
      }
      return hits;
    },
    // Pictures and clips too small to be useful, shrunk so far their text cannot be read, or stretched past their own size.
    tiny_images: rule => {
      const hint = new RegExp(rule.screenshot_hint, 'i');
      const hits = [];
      for (const element of all(selectors.content_media)) {
        if (element.closest(selectors.media_ignored)) continue;
        const video = element.tagName === 'VIDEO';
        const source = video ? (element.currentSrc || element.getAttribute('src') || '') : (element.currentSrc || element.src || '');
        if (!video && /\.svg(\?|$)/i.test(source)) continue;
        const natural = video ? element.videoWidth : element.naturalWidth;
        if (natural < rule.min_natural_px) continue;
        const alt = video ? '' : (element.getAttribute('alt') || '').trim();
        const screenshot = hint.test(alt + ' ' + source + ' ' + element.className);
        if (!(video || screenshot || natural >= rule.large_natural_px || alt.length >= rule.min_alt_chars)) continue;
        const box = element.getBoundingClientRect();
        const text = (alt || source.split('/').pop() || element.tagName.toLowerCase()).slice(0, 80);
        const common = { text, selector: pathOf(element), natural: Math.round(natural), rendered: Math.round(box.width) };
        const container = element.parentElement && element.parentElement.closest(selectors.media_containers);
        if (container && rule.fraction_widths.includes(widthId)) {
          const style = getComputedStyle(container);
          const space = container.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          // A picture beside its words is a row, not a small picture in a wide card.
          const beside = [...container.querySelectorAll(selectors.text)].some(other => {
            if (other.contains(element) || element.contains(other) || !ownText(other) || !shown(other)) return false;
            const near = other.getBoundingClientRect();
            const overlap = Math.min(near.bottom, box.bottom) - Math.max(near.top, box.top);
            return overlap > Math.min(near.height, box.height) * 0.5 && (near.left >= box.right - 1 || near.right <= box.left + 1);
          });
          const fraction = box.width / space;
          if (!beside && space > 0 && fraction < rule.min_fraction) hits.push({ values: { ...common, kind: 'small', container: Math.round(space), percent: Math.round(fraction * 100), min_percent: Math.round(rule.min_fraction * 100) }, element });
        }
        const downscale = natural / box.width;
        if (screenshot && downscale > rule.max_downscale) hits.push({ values: { ...common, kind: 'downscaled', ratio: downscale.toFixed(1), max_ratio: rule.max_downscale, text_px: (rule.screenshot_text_px / downscale).toFixed(1) }, element });
        const fit = getComputedStyle(element).objectFit;
        const scale = fit === 'cover' ? Math.max(box.width / natural, box.height / (video ? element.videoHeight : element.naturalHeight)) : box.width / natural;
        if (scale > rule.max_upscale) hits.push({ values: { ...common, kind: 'upscaled', percent: Math.round(scale * 100), max_percent: Math.round(rule.max_upscale * 100) }, element });
      }
      return hits;
    },
    // Looping clips that never load or have no length. (An embedded live demo is watched from outside the page: watchDemos.)
    stale_demo: async rule => {
      const clips = all(selectors.videos).filter(video => video.loop || video.autoplay || video.preload !== 'none');
      const settled = video => video.error || video.readyState >= 1 || video.networkState === 3;
      const until = Date.now() + rule.video_wait_seconds * 1000;
      while (clips.some(video => !settled(video)) && Date.now() < until) await new Promise(done => setTimeout(done, 200));
      return clips.map(video => {
        const src = video.currentSrc || video.getAttribute('src') || (video.querySelector('source') || {}).src || '';
        const base = { text: src.split('/').pop() || 'video', selector: pathOf(video) };
        if (video.error || video.networkState === 3 || video.readyState === 0) return { values: { ...base, kind: 'video_failed' }, element: video };
        return Number.isFinite(video.duration) && video.duration <= 0 ? { values: { ...base, kind: 'video_empty' }, element: video } : null;
      });
    },
  };
  const found = [];
  for (const rule of rules) {
    const measure = MEASURES[rule.id];
    if (!measure) continue;
    for (const hit of (await measure(rule, controlNames)).filter(Boolean)) found.push({
      rule: rule.id,
      values: hit.values,
      text: hit.values.text,
      selector: hit.selector ?? (hit.element ? pathOf(hit.element) : undefined),
      ...(hit.identitySelector ? {identitySelector: hit.identitySelector, displaySelector: hit.displaySelector} : {}),
      rect: hit.element ? where(hit.element) : null,
    });
  }
  const links = all(selectors.links).map(element => ({ href: element.href, text: words(element).slice(0, 60) })).filter(link => /^https?:/.test(link.href) && !link.href.includes('#'));
  return { found, unsupported: rules.filter(rule => !MEASURES[rule.id]).map(rule => rule.id), links, height: document.documentElement.scrollHeight,
    ...(renderedLabels === null ? {} : {rendered_labels:renderedLabels}) };
})`;

