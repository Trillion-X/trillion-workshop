// packages/ui/show/action-row/action-row.tsx
//
// PURPOSE
//   The one row of actions for a selection or an open item: a rounded surface
//   holding icon buttons, where the hovered or focused action grows to show its
//   name. It is the DOM-page form of ExpandableTabs (action mode, 21st.dev 1428)
//   with the surface anatomy of beui's Expandable Action Bar (21st.dev 26780):
//   one track, one radius, one height, every action the same weight.
//
//   Pages that are not React own their buttons (their listeners, disabled and
//   hidden state, and the words they change as a selection grows). This part
//   never replaces those buttons. It gives each one the row's shape (an icon
//   from its `data-menu-icon`, then its words in a label that opens on hover or
//   focus) and keeps that shape when the page rewrites a button's words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page's buttons stay the page's: same element, same listeners, same
//      disabled/hidden state. Adding an action is adding a button.
//   2. The icon is DATA on the button (`data-menu-icon`, a NamedIcon name). A
//      button without one shows its words, so no action is ever unlabeled.
//   3. The words stay in the button's text, so its accessible name is its
//      words whether or not the label is open.
//   4. Appearance lives only in screen-look/show/action-row.css.
//   5. Rewriting a button's words (textContent) is noticed and re-shaped once;
//      shaping never triggers another shaping.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {NamedIcon} from '../icon/NamedIcon';

export type ActionRowOptions = {
  /** What the row is for, read by assistive technology ("Selection actions"). */
  label: string;
};

const ICON_CLASS = 'ui-action-row-icon';
const LABEL_CLASS = 'ui-action-row-label';
const iconRoots = new WeakMap<HTMLElement, Root>();
const rows = new WeakMap<HTMLElement, MutationObserver>();

function labelOf(button: HTMLButtonElement): string {
  const label = button.querySelector(`:scope > .${LABEL_CLASS}`);
  const shapedIcon = button.querySelector(`:scope > .${ICON_CLASS}`);
  // A shaped button whose words were not rewritten still holds exactly [icon, label].
  if (label && shapedIcon && button.childNodes.length === 2) return label.textContent ?? '';
  return [...button.childNodes].filter(node => !(node instanceof HTMLElement && node.classList.contains(ICON_CLASS))).map(node => node.textContent ?? '').join('').trim();
}

function shape(button: HTMLButtonElement) {
  const icon = button.dataset.menuIcon || '';
  const words = labelOf(button);
  const current = button.querySelector<HTMLElement>(`:scope > .${ICON_CLASS}`);
  const currentLabel = button.querySelector<HTMLElement>(`:scope > .${LABEL_CLASS}`);
  if (button.childNodes.length === 2 && current?.dataset.icon === icon && currentLabel?.textContent === words) return;
  button.dataset.actionRowItem = icon ? 'icon' : 'words';
  const label = currentLabel ?? document.createElement('span');
  label.className = LABEL_CLASS;
  label.textContent = words;
  if (!icon) { button.replaceChildren(label); return; }
  let iconHost = current;
  if (!iconHost) {
    iconHost = document.createElement('span');
    iconHost.className = ICON_CLASS;
    iconHost.setAttribute('aria-hidden', 'true');
  }
  if (iconHost.dataset.icon !== icon) {
    let root = iconRoots.get(iconHost);
    if (!root) { root = createRoot(iconHost); iconRoots.set(iconHost, root); }
    const drawn = root;
    flushSync(() => drawn.render(<NamedIcon name={icon} size="md" />));
    iconHost.dataset.icon = icon;
  }
  button.replaceChildren(iconHost, label);
}

/**
 * Give a page-owned row of buttons the shared action-row look and behaviour.
 * Returns a function that stops following the row (its buttons keep their shape).
 */
export function enhanceActionRow(node: HTMLElement | null, {label}: ActionRowOptions): () => void {
  if (!node) return () => {};
  rows.get(node)?.disconnect();
  node.classList.add('ui-action-row');
  if (!node.getAttribute('role')) node.setAttribute('role', 'toolbar');
  node.setAttribute('aria-label', label);
  // A button another renderer owns (a React root such as the overflow menu's
  // trigger, or anything marked data-action-row-skip) takes the look from CSS
  // only; rewriting its children would fight that renderer.
  const pageOwned = (button: HTMLButtonElement) => {
    const owner = button.parentElement?.closest('[data-shared-root],[data-action-row-skip]');
    return !owner || owner === node || !node.contains(owner);
  };
  const shapeAll = () => { for (const button of node.querySelectorAll<HTMLButtonElement>('button')) if (pageOwned(button)) shape(button); };
  let shaping = false;
  const observer = new MutationObserver(() => {
    if (shaping) return;
    shaping = true;
    try { shapeAll(); } finally { observer.takeRecords(); shaping = false; }
  });
  shaping = true;
  shapeAll();
  shaping = false;
  observer.observe(node, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-menu-icon']});
  rows.set(node, observer);
  return () => { observer.disconnect(); rows.delete(node); };
}
