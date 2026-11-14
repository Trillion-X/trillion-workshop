// One semantic plan card for server pages and React hosts. The caller supplies
// the offer facts; this part alone writes the plan's HTML.
import { escapeHtml } from 'trillion-workshop/tools/write-a-post-for-each-place/read-data/escape-html.mjs';

// The marks are drawn, not typed: a check and a cross are not in every page's text face.
const MARK = {
  yes: '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 16 16" width="13" height="13" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const text = value => String(value ?? '').trim();
const safeHref = value => {
  const href = text(value);
  return (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('#') || /^https?:\/\//i.test(href) ? href : '';
};

export function planCardContentsHtml(plan) {
  const name = text(plan?.name);
  if (!name) return '';
  const price = text(plan?.price);
  const summary = text(plan?.summary);
  const action = plan?.action;
  const href = safeHref(action?.href);
  const label = text(action?.label);
  const notes = Array.isArray(plan?.notes) ? plan.notes.map(value => ({ label: text(value), included: true })) : [];
  const lines = Array.isArray(plan?.lines) ? plan.lines.map(line => typeof line === 'string'
    ? { label: text(line), included: true }
    : { label: text(line?.label), value: text(line?.value), included: line?.included !== false }) : [];
  const features = [...notes, ...lines].filter(line => line.label);
  return `<div class="trillion-plan-card__head"><h3 class="trillion-plan-card__name">${escapeHtml(name)}</h3>`
    + (price ? `<p class="trillion-plan-card__price">${escapeHtml(price)}</p>` : '')
    + (summary ? `<p class="trillion-plan-card__summary">${escapeHtml(summary)}</p>` : '')
    + '</div>'
    + (href && label ? `<a class="trillion-plan-card__action" data-plan-action href="${escapeHtml(href)}">${escapeHtml(label)}<span aria-hidden="true">→</span></a>` : '')
    + (features.length ? `<ul class="trillion-plan-card__features" aria-label="${escapeHtml(text(plan?.linesLabel) || `${name} includes`)}">${features.map(line => `<li data-included="${line.included}"><span class="trillion-plan-card__mark" aria-hidden="true">${line.included ? MARK.yes : MARK.no}</span><span><span class="trillion-plan-card__sr">${line.included ? 'Included: ' : 'Not included: '}</span>${escapeHtml(line.label)}${line.value && line.included ? `<strong class="trillion-plan-card__value">${escapeHtml(line.value)}</strong>` : ''}</span></li>`).join('')}</ul>` : '');
}

export function planCardHtml(plan) {
  const inner = planCardContentsHtml(plan);
  if (!inner) return '';
  return `<li class="trillion-plan-card" data-highlighted="${Boolean(plan?.recommended || plan?.highlighted)}" data-plan-id="${escapeHtml(text(plan?.id))}">${inner}</li>`;
}
