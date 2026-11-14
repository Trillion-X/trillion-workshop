// package://packages/subject-participant/show/mount-subject-participant.js

import { readPackageBoundarySurface } from '../read-data/subject-participant-surface.js';

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'style') Object.assign(node.style, value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function pill(text) {
  return element('span', {
    style: {
      border: '1px solid var(--bf-border-muted, rgba(70, 92, 74, 0.24))',
      borderRadius: '999px',
      color: 'var(--bf-text-muted, #526257)',
      font: '500 11px/1.2 var(--bf-font-label, ui-sans-serif)',
      padding: '6px 9px',
    },
  }, [text]);
}

export function renderPackageBoundarySurface(surface = readPackageBoundarySurface()) {
  const section = element('section', {
    'data-package-boundary-surface': surface.packageName,
    style: {
      background: 'linear-gradient(135deg, var(--bf-surface, #f7f5ee), var(--bf-surface-raised, #eef3eb))',
      border: '1px solid var(--bf-border, rgba(42, 63, 48, 0.18))',
      borderRadius: '24px',
      boxShadow: '0 24px 80px rgba(33, 43, 36, 0.14)',
      color: 'var(--bf-text, #18221d)',
      display: 'grid',
      gap: '18px',
      maxWidth: '860px',
      padding: '28px',
    },
  });

  section.append(
    element('header', { style: { display: 'grid', gap: '8px' } }, [
      element('div', { style: { color: 'var(--bf-accent, #586f4d)', font: '700 11px/1.2 var(--bf-font-label, ui-sans-serif)', letterSpacing: '0.16em', textTransform: 'uppercase' } }, ['Package Boundary']),
      element('h1', { style: { font: '700 32px/1 var(--bf-font-display, ui-serif)', margin: '0' } }, [surface.title]),
      element('p', { style: { color: 'var(--bf-text-muted, #526257)', font: '400 14px/1.6 var(--bf-font-body, ui-sans-serif)', margin: '0', maxWidth: '68ch' } }, [surface.summary]),
    ]),
  );

  const grid = element('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } });
  for (const [label, values] of [['Owns', surface.owns], ['Actions', surface.actions.map((action) => action.action)], ['Source contract', surface.sourceContract]]) {
    grid.append(element('article', { style: { background: 'rgba(255, 255, 255, 0.54)', border: '1px solid var(--bf-border-muted, rgba(70, 92, 74, 0.18))', borderRadius: '18px', display: 'grid', gap: '10px', padding: '14px' } }, [
      element('strong', { style: { font: '700 12px/1.2 var(--bf-font-label, ui-sans-serif)' } }, [label]),
      element('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, values.map(pill)),
    ]));
  }
  section.append(grid);

  section.append(element('footer', { style: { color: 'var(--bf-text-muted, #526257)', font: '500 12px/1.5 var(--bf-font-body, ui-sans-serif)' } }, [
    'External execution owners are chosen by package-set data and are not named by this source.'
  ]));

  return section;
}

export function mount({ el }) {
  el.replaceChildren(renderPackageBoundarySurface());
  return () => el.replaceChildren();
}

export default mount;
