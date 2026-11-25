// tools/serve-a-sites-pages-from-its-rows/do-work/render-layout.ts
//
// PURPOSE
//   Draws a page's tree of parts as one React element. The tree is a page row's layout once every tool node holds its answer
//   (render.ts drawnTreeOf): each node names a module key ("<file under tools>#<export>") and its props, or is words. The same
//   function draws on the server (renderToStaticMarkup) and in the browser (the mount script), from the same tree, so a page and
//   its mount never draw differently.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window, no file read; the modules are given.
//   2. A node whose module is not given throws: a page is never drawn with a part left out.
//   3. Props are plain JSON from rows and tool answers; nothing here adds a prop of its own except React's own key.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createElement, Fragment } from 'react';
import type { ComponentType, ReactNode } from 'react';

export type DrawnNode =
  | { module: string; props?: Record<string, unknown>; children?: DrawnNode[] }
  | { text: string }
  | { nodes: DrawnNode[] };

export type Modules = Record<string, ComponentType<Record<string, unknown>>>;

/** The module key a part or a screen is found by in a page's bundle: its file under the tools folder and its export. */
export const moduleKey = (file: string, name: string): string => `${file}#${name}`;

function drawn(node: DrawnNode, modules: Modules, key: number): ReactNode {
  if ('text' in node) return node.text;
  if ('nodes' in node) return createElement(Fragment, { key }, ...node.nodes.map((child, i) => drawn(child, modules, i)));
  const component = modules[node.module];
  if (!component) throw new Error(`The page's bundle holds no module ${node.module}.`);
  const children = (node.children ?? []).map((child, i) => drawn(child, modules, i));
  return createElement(component, { ...(node.props ?? {}), key }, ...children);
}

/** The whole tree as one element. */
export function layoutElement(tree: DrawnNode, modules: Modules): ReactNode {
  return createElement(Fragment, null, drawn(tree, modules, 0));
}

/** Every module key the tree names, each once, in a fixed order: the page's bundle is made from exactly these. */
export function modulesOf(tree: DrawnNode): string[] {
  const keys = new Set<string>();
  const walk = (node: DrawnNode) => {
    if ('text' in node) return;
    if ('nodes' in node) { node.nodes.forEach(walk); return; }
    keys.add(node.module);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return [...keys].sort();
}
