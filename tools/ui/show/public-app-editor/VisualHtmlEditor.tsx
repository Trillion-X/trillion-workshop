import downloads from './module-downloads.json';
// Shared visual HTML/CSS canvas. GrapesJS core 0.23.6 is BSD-3-Clause.
// The caller owns saving, versioning and access checks.
//
// The page is laid out on an infinite canvas, the way Figma and Framer show a design: one frame per size in
// breakpoints.json side by side (Desktop, Tablet, Phone), all showing the same page, so a change made in any of them is
// seen at every size at once. Scroll or drag to move around, pinch or Ctrl/Cmd-scroll to zoom. The layers on the left
// are the page as a tree (shared LayerTree, names from layer-kinds.json). Other people and AIs working on the same page
// are drawn on the canvas where they are pointing or what they are changing (`peers`); this component only draws them
// and reports where this person points (`onPointer`), the caller carries both.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Component, Editor, Frame } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import { Button } from '../button';
import { ScreenState } from '../screen-state';
import { retryableEditorDownload, useEditorDownload } from './editor-download';
import { NamedIcon } from '../icon/NamedIcon';
import { LayerTree, type LayerTreeMove, type LayerTreeNode } from '../layer-tree/LayerTree';
import { SearchField } from '../search-field/SearchField';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import '../../../screen-look/show/public-app-editor.css';
import BREAKPOINTS from './breakpoints.json';
import STYLE_SETTINGS_DATA from './style-settings.json';
import { TuningPanel, settingFromCss, settingToCss, type TuningSection, type TuningValue } from '../tuning-panel';
import { SegmentedControl } from '../segmented-control/SegmentedControl';
import CHANGE_SCOPES from './change-scopes.json';
import EDITOR_LAYOUT from './editor-layout.json';
import { SplitDividers } from '../split-dividers/SplitDividers';
import { layerHoldsOnlyWords, layerLabel } from './layer-names';
import { captureVisualSelection, type VisualSelectionRef } from './selection-ref';

// The page editor's engine is fetched the first time an editor opens, never with the screen.
const loadGrapes = retryableEditorDownload(() => import('grapesjs').then(module => module.default), downloads.engine);

export type VisualHtmlEditorHandle = {
  exportFiles: () => { html: string; css: string };
  bindSelectedForm: (actionPath: string) => boolean;
  placeCapability: (placementId: string, label: string) => boolean;
  placeImageAsset: (url: string, alt: string) => boolean;
  /** Changes made here since the page opened that are not saved yet. */
  hasUnsavedChanges: () => boolean;
  /** Takes a draft someone else saved into the open page, part by part by element address, keeping every unsaved change
   *  made here. Answers false, changing nothing, when both changed the same part or the page's parts were added, removed
   *  or moved, or the styles changed on both sides; the caller then opens the page again or says so. */
  takeChanges: (html: string, css: string, renderCss?: string) => boolean;
};
type Props = { html: string; css: string; revision: string; baseUrl?: string; renderCss?: string };
export type EditorLibraryItem = { id: string; label: string; group: string; detail?: string; context?: string; action?: string; canDrag?: boolean; onChoose?: () => void };
export type EditorReference = {
  id: string; title: string; app: string; platform: string; screenKind: string; anatomy: string; patterns: string[]; sourceUrl: string;
};
/** The selected part's style rows (style-settings.json), drawn as tuning controls. */
const STYLE_SETTINGS = STYLE_SETTINGS_DATA as { sections: TuningSection[] };
/** Every style row by its CSS property; a row of side-by-side rows counts each of them, not itself. */
const STYLE_SETTING_BY_KEY = new Map(STYLE_SETTINGS.sections.flatMap(section => section.settings.flatMap(setting => setting.settings ?? [setting])).map(setting => [setting.key, setting] as const));

/** What each style row shows: the part's own style when it has one, else what the page draws it with now. */
function styleValues(selected: Component, style: Record<string, string>): Record<string, TuningValue> {
  const element = selected.getEl();
  const drawn = element ? element.ownerDocument.defaultView?.getComputedStyle(element) : null;
  return Object.fromEntries([...STYLE_SETTING_BY_KEY.values()].map(setting => {
    const raw = style[setting.key] || drawn?.getPropertyValue(setting.key) || '';
    return [setting.key, settingFromCss(setting, raw) as TuningValue];
  }));
}

/** Someone else on this page: a cursor at a canvas point, or what they are changing (the element's address, else a selector
 *  or words on the page). */
export type CanvasPeer = { id: string; name: string; color: string; cursor?: { x: number; y: number }; target?: { element?: string; selector?: string; text?: string }; doing?: string };
type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };
type PlacedPeer = CanvasPeer & { at: Point; boxes: Box[] };

/** Who a style change reaches (change-scopes.json): the picked parts, or every part whose facts equal the selected one's. */
type ChangeScope = { id: string; label: string; picked?: boolean; match?: string[] };
const SCOPES = (CHANGE_SCOPES as { scopes: ChangeScope[] }).scopes;
/** One fact of a part: its element name, its classes in any order, or an attribute's value ('' when it has none, which
 *  parts without it share). */
function factOf(component: Component, fact: string): string {
  if (fact === 'tag') return String(component.get('tagName') ?? '').toLowerCase();
  if (fact === 'class') return component.getClasses().map(String).sort().join(' ');
  const value = component.getAttributes()[fact];
  return typeof value === 'string' ? value : '';
}
/** Every part a change made on `selected` reaches under `scope`. */
function partsInScope(visual: Editor, selected: Component, scope: ChangeScope): Component[] {
  if (scope.picked) { const picked = visual.getSelectedAll(); return picked.length ? picked : [selected]; }
  const facts = (scope.match ?? []).map(fact => [fact, factOf(selected, fact)] as const);
  if (!facts.length) return [selected];
  return visual.getWrapper()?.find('*').filter(part => facts.every(([fact, value]) => factOf(part, fact) === value)) ?? [selected];
}
type Placed = { id: string; label: string; x: number; y: number; width: number; height: number };

const nodesAsHtml = (nodes: NodeListOf<ChildNode>) => {
  const serializer = new XMLSerializer();
  return Array.from(nodes).map(node => serializer.serializeToString(node)).join('');
};
const textOf = (component: Component) => component.getEl()?.textContent ?? '';

/** Place a reusable item in the selected layout container, or beside selected text. */
function capabilityContainer(visual: Editor, selected: Component | null): Component {
  const wrapper = visual.getWrapper();
  const containers = new Set(['main', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'div']);
  let target = visual.getSelected() ?? selected;
  while (target && target !== wrapper) {
    const tag = String(target.get('tagName') ?? '').toLowerCase();
    if (containers.has(tag) && target.get('droppable') !== false) return target;
    target = target.parent() ?? null;
  }
  return wrapper.find('main')[0] ?? wrapper;
}

/** The layers of a page: every element as a row, words-only elements as one row each. */
function layersOf(wrapper: Component, byId: Map<string, Component>): LayerTreeNode[] {
  const visit = (component: Component): LayerTreeNode | null => {
    const type = String(component.get('type') ?? '');
    if (type === 'textnode' || type === 'comment') return null;
    const tag = String(component.get('tagName') || 'div').toLowerCase();
    const attributes = component.getAttributes();
    const heading = component.find('h1,h2,h3,h4,h5,h6')[0];
    const { name, icon } = layerLabel({
      tag, given: String(component.get('name') ?? '') || attributes['aria-label'],
      text: textOf(component), alt: attributes.alt, placeholder: attributes.placeholder ?? attributes.name, title: attributes.title,
      className: attributes.class, heading: heading ? textOf(heading) : undefined,
    });
    byId.set(component.cid, component);
    const onlyWords = layerHoldsOnlyWords(tag);
    const children = onlyWords ? [] : component.components().models.map(visit).filter((node): node is LayerTreeNode => node !== null);
    return { id: component.cid, name, icon, children, holds: !onlyWords && component.get('droppable') !== false };
  };
  return wrapper.components().models.map(visit).filter((node): node is LayerTreeNode => node !== null);
}

export const VisualHtmlEditor = forwardRef<VisualHtmlEditorHandle, Props & {
  libraryItems?: EditorLibraryItem[]; pages?: { id: string; label: string; htmlPath?: string; route?: string }[]; selectedPage?: string; onChoosePage?: (id: string) => void;
  references?: EditorReference[]; referencesQuery?: string; referencesStatus?: 'loading' | 'ready' | 'failed'; onSearchReferences?: (query: string) => void;
  onSelection?: (selection: VisualSelectionRef | null) => void; onReady?: (ready: boolean) => void; selectionPanel?: React.ReactNode;
  peers?: CanvasPeer[]; onPointer?: (point: Point | null) => void;
}>(function VisualHtmlEditor({ html, css, revision, baseUrl, renderCss, libraryItems = [], pages = [], selectedPage, onChoosePage, references = [], referencesQuery = '', referencesStatus = 'ready', onSearchReferences, onSelection, onReady, selectionPanel, peers = [], onPointer }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editorBody = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const lastSelected = useRef<Component | null>(null);
  const components = useRef(new Map<string, Component>());
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onPointerRef = useRef(onPointer);
  onPointerRef.current = onPointer;
  const original = useRef(html);
  const originalCss = useRef(css);
  const resourceBase = useRef(baseUrl);
  resourceBase.current = baseUrl;
  // The caller supplies this installation's live or saved-draft page address.
  // Only the canvas gets a base: exported source keeps its original asset paths.
  const mountResourceBase = () => {
    if (!resourceBase.current) return;
    let page: URL;
    try { page = new URL(resourceBase.current); } catch { return; }
    if (!/^https?:$/.test(page.protocol) || page.username || page.password) return;
    const document = new DOMParser().parseFromString(original.current, 'text/html');
    const importedBase = document.head.querySelector('base[href]')?.getAttribute('href');
    let resolved = page;
    try { if (importedBase) resolved = new URL(importedBase, page); } catch { /* A malformed imported base cannot stop the editor. */ }
    const href = resolved.origin === page.origin ? resolved.href : page.href;
    host.current?.querySelectorAll<HTMLIFrameElement>('iframe.gjs-frame').forEach(frame => {
      const head = frame.contentDocument?.head;
      if (!head) return;
      const previousBase = head.ownerDocument.baseURI;
      let base = head.querySelector<HTMLBaseElement>('base[data-trillion-resource-base]');
      if (!base) {
        base = head.ownerDocument.createElement('base');
        base.setAttribute('data-trillion-resource-base', '');
        head.prepend(base);
      }
      if (base.href === href) return;
      base.href = href;
      // Updating <base> changes URL properties without making browsers reload
      // images or reparse already-resolved CSS. Refresh resource attributes and
      // style text in place; the GrapesJS model and unsaved work stay intact.
      const canvasDocument = head.ownerDocument;
      canvasDocument.querySelectorAll('style').forEach(style => {
        const content = style.textContent;
        style.textContent = '';
        style.textContent = content;
      });
      canvasDocument.querySelectorAll('[style]').forEach(node => {
        const content = node.getAttribute('style')!;
        node.removeAttribute('style');
        node.setAttribute('style', content);
      });
      canvasDocument.querySelectorAll('img, source, video, audio, track, embed, object, image, use, link, iframe, frame, input[type="image"]').forEach(node => {
        for (const attribute of ['src', 'srcset', 'poster', 'data', 'href', 'xlink:href']) {
          if (!node.hasAttribute(attribute)) continue;
          const value = node.getAttribute(attribute)!;
          if (attribute !== 'srcset') {
            try { if (new URL(value, previousBase).href === new URL(value, href).href) continue; } catch { /* Relative resources still need their new valid base. */ }
          }
          node.setAttribute(attribute, value);
        }
      });
    });
  };
  // A page whose changes were taken in place (takeChanges) is not opened again when it arrives as the next html.
  const adopted = useRef<string | null>(null);
  const opened = useRef({ html, css, revision, key: 0 });
  if (opened.current.html !== html || opened.current.css !== css || opened.current.revision !== revision) {
    opened.current = { html, css, revision, key: adopted.current === html ? opened.current.key : opened.current.key + 1 };
    adopted.current = null;
  }
  const openKey = opened.current.key;
  const revisionNow = useRef(revision);
  revisionNow.current = revision;
  const styleChanged = useRef(false);
  // The page's markup as it opened, or as it was after another person's change was taken in with nothing unsaved here:
  // the page has unsaved changes when its markup differs from this (selecting or pointing at a part changes nothing).
  const markupAtRest = useRef<string | null>(null);
  const [selected, setSelected] = useState<Component | null>(null);
  const [style, setStyle] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryCategory, setLibraryCategory] = useState('all');
  const [leftView, setLeftView] = useState<'layers' | 'library' | 'sources'>('layers');
  const [panelWidths, setPanelWidths] = useState({ library: EDITOR_LAYOUT.panels.library.initial, inspector: EDITOR_LAYOUT.panels.inspector.initial });
  const panelStarts = useRef(panelWidths);
  const fitPanels = () => {
    const body = editorBody.current;
    if (!body || getComputedStyle(body).gridTemplateColumns.split(/\s+/).length !== 4) return;
    const minimum = EDITOR_LAYOUT.panels.library.minimum + EDITOR_LAYOUT.panels.inspector.minimum;
    const budget = body.clientWidth - EDITOR_LAYOUT.rail - EDITOR_LAYOUT.canvas_minimum;
    if (budget < minimum) return;
    setPanelWidths(current => {
      const total = current.library + current.inspector;
      if (total <= budget) return current;
      const scale = (budget - minimum) / (total - minimum);
      return {
        library: Math.floor(EDITOR_LAYOUT.panels.library.minimum + (current.library - EDITOR_LAYOUT.panels.library.minimum) * scale),
        inspector: Math.floor(EDITOR_LAYOUT.panels.inspector.minimum + (current.inspector - EDITOR_LAYOUT.panels.inspector.minimum) * scale),
      };
    });
  };
  const sizePanel = (name: 'library' | 'inspector', width: number) => {
    const row = EDITOR_LAYOUT.panels[name];
    const other = name === 'library' ? 'inspector' : 'library';
    setPanelWidths(current => {
      const available = (editorBody.current?.clientWidth ?? 1200) - EDITOR_LAYOUT.rail - current[other] - EDITOR_LAYOUT.canvas_minimum;
      return { ...current, [name]: Math.round(Math.max(row.minimum, Math.min(width, row.maximum, available))) };
    });
  };
  const panelDivider = (name: 'library' | 'inspector') => {
    const row = EDITOR_LAYOUT.panels[name];
    const direction = name === 'library' ? 1 : -1;
    return <div className="trillion-visual-editor__panel-divider" data-edge={name === 'library' ? 'right' : 'left'}>
      <SplitDividers axis="x" revealed label={row.label} value={{ now: panelWidths[name], min: row.minimum, max: row.maximum }}
        dividers={[{ leftIndex: 0, rightIndex: 1, left: 0, top: 0, width: '100%', height: '100%' }]}
        onResizeStart={() => { panelStarts.current = panelWidths; }}
        onResize={(_left, _right, delta) => sizePanel(name, panelStarts.current[name] + delta * direction)}
        onResizeStep={step => sizePanel(name, step === 'reset' ? row.initial : step === 'minimum' ? row.minimum : step === 'maximum' ? row.maximum
          : panelWidths[name] + (step === 'increase' ? 1 : -1) * direction * EDITOR_LAYOUT.keyboard_step)} />
    </div>;
  };
  const [layers, setLayers] = useState<LayerTreeNode[]>([]);
  const [zoom, setZoom] = useState(100);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [peerSpots, setPeerSpots] = useState<PlacedPeer[]>([]);
  const [scopeId, setScopeId] = useState(SCOPES[0]?.id ?? '');
  const [pickedCount, setPickedCount] = useState(0);
  const libraryItemsRef = useRef<EditorLibraryItem[]>(libraryItems);
  libraryItemsRef.current = libraryItems;
  const peersRef = useRef(peers);
  peersRef.current = peers;

  const add = (kind: 'text' | 'image' | 'section') => {
    const visual = editor.current;
    if (!visual) return;
    const content = kind === 'text' ? { type: 'text', content: 'Write here' }
      : kind === 'image' ? { type: 'image' }
      : { tagName: 'section', components: [{ type: 'text', content: 'Section text' }] };
    const target = visual.getSelected() ?? visual.getWrapper();
    const added = target?.append(content);
    if (added?.[0]) visual.select(added[0]);
  };
  const scope = SCOPES.find(row => row.id === scopeId) ?? SCOPES[0];
  const reached = selected && editor.current && scope ? partsInScope(editor.current, selected, scope) : [];
  const changeStyle = (property: string, value: string) => {
    if (!selected) return;
    styleChanged.current = true;
    for (const part of reached.length ? reached : [selected]) part.addStyle({ [property]: value });
    setStyle(current => ({ ...current, [property]: value }));
  };
  const frames = () => editor.current?.Canvas.getFrames() ?? [];
  const boxOf = (frame: Frame) => ({ x: Number(frame.get('x') ?? 0), y: Number(frame.get('y') ?? 0), width: Number(frame.width), height: Number(frame.height) });
  /** Zoom and move so the given canvas box fills the view, leaving `gap` pixels around it. */
  // Until the person moves or zooms the canvas themselves, it keeps every size in view as its pane changes size.
  const moved = useRef(false);
  const fitting = useRef(false);
  const fitMode = useRef<number | 'all'>(0);
  const showBox = (box: { x: number; y: number; width: number; height: number }, gap = 32) => {
    const visual = editor.current;
    const view = host.current?.querySelector<HTMLElement>('.gjs-cv-canvas');
    if (!visual || !view || !view.clientWidth || !view.clientHeight) return;
    fitting.current = true;
    const width = view.clientWidth;
    const height = view.clientHeight;
    const scale = Math.max(0.05, Math.min(1, (width - gap * 2) / box.width, (height - gap * 2) / box.height));
    visual.Canvas.setZoom(scale * 100);
    const coords = visual.Canvas.getCoords();
    const origin = visual.Canvas.getWorldRectToScreen({ x: 0, y: 0, width: 0, height: 0 });
    const delta = { x: (origin?.x ?? 0) - coords.x, y: (origin?.y ?? 0) - coords.y };
    visual.Canvas.setCoords((width - box.width * scale) / 2 - box.x * scale - delta.x, gap - box.y * scale - delta.y);
    fitting.current = false;
  };
  const showFrame = (at: number) => {
    const frame = frames()[at];
    if (!frame) return;
    moved.current = false;
    fitMode.current = at;
    showBox(boxOf(frame));
  };
  const showPrimary = () => {
    const width = host.current?.querySelector<HTMLElement>('.gjs-cv-canvas')?.clientWidth ?? 0;
    showFrame(width > 0 && width < 700 ? BREAKPOINTS.frames.length - 1 : 0);
  };
  const showAll = () => {
    moved.current = false;
    fitMode.current = 'all';
    const boxes = frames().map(boxOf);
    if (!boxes.length) return;
    const left = Math.min(...boxes.map(box => box.x));
    const top = Math.min(...boxes.map(box => box.y));
    showBox({ x: left, y: top, width: Math.max(...boxes.map(box => box.x + box.width)) - left, height: Math.max(...boxes.map(box => box.y + box.height)) - top });
  };
  const zoomBy = (factor: number) => {
    const visual = editor.current;
    const view = host.current?.querySelector<HTMLElement>('.gjs-cv-canvas');
    if (!visual || !view) return;
    const before = visual.Canvas.getZoomDecimal();
    const next = Math.max(0.05, Math.min(4, before * factor));
    // Zoom toward the middle of the view, so what is in the middle stays there.
    const coords = visual.Canvas.getCoords();
    const middle = { x: view.clientWidth / 2, y: view.clientHeight / 2 };
    visual.Canvas.setZoom(next * 100);
    visual.Canvas.setCoords(middle.x - (middle.x - coords.x) * (next / before), middle.y - (middle.y - coords.y) * (next / before));
  };

  const engineDownload = useEditorDownload(loadGrapes, onReady);
  const engine = engineDownload.value;
  useEffect(() => {
    if (!host.current || !engine) return;
    original.current = html;
    originalCss.current = css;
    styleChanged.current = false;
    markupAtRest.current = null;
    lastSelected.current = null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Imported sites often keep their design in the page head. Keep those
    // style nodes in the canvas document instead of folding them into GrapesJS
    // rules: the original head remains the source of truth on export, including
    // media attributes and style order.
    const pageStyles = Array.from(doc.head.querySelectorAll('style'));
    const mountHeadStyles = () => {
      mountResourceBase();
      if (!pageStyles.length) return;
      host.current?.querySelectorAll<HTMLIFrameElement>('iframe.gjs-frame').forEach(frame => {
        const head = frame.contentDocument?.head;
        if (!head || head.querySelector('style[data-trillion-imported-head]')) return;
        for (const style of pageStyles) {
          const copy = head.ownerDocument.importNode(style, true);
          copy.setAttribute('data-trillion-imported-head', '');
          head.append(copy);
        }
      });
    };
    const [first, ...others] = BREAKPOINTS.frames;
    const visual = engine.init({
      container: host.current,
      height: '100%',
      width: 'auto',
      storageManager: false,
      fromElement: false,
      panels: { defaults: [] },
      // The first size is the editor's one device, so nothing resizes its frame to the view's width.
      deviceManager: { devices: [{ id: first.id, name: first.label, width: `${first.width}px`, height: `${first.height}px` }] },
      canvas: { infiniteCanvas: true, styles: [] },
      pageManager: { pages: [{ id: 'page', frames: [{ id: first.id, component: nodesAsHtml(doc.body.childNodes), width: first.width, height: first.height, x: 0, y: 0 }] }] },
      style: renderCss ?? css,
      selectorManager: { componentFirst: true },
    });
    visual.Blocks.add('text', { label: 'Text', category: 'Content', content: { type: 'text', content: 'Write here' } });
    visual.Blocks.add('image', { label: 'Image', category: 'Content', content: { type: 'image' } });
    visual.Blocks.add('section', { label: 'Section', category: 'Layout', content: { tagName: 'section', components: [{ type: 'text', content: 'Section text' }] } });
    const readLayers = () => {
      const byId = new Map<string, Component>();
      setLayers(layersOf(visual.getWrapper(), byId));
      components.current = byId;
    };
    // Where each frame's name sits and where everyone else is, in this view's pixels; read again whenever the view moves.
    let drawing = 0;
    // The editor answers its own events while it is being destroyed; a draw asked for then never runs against it.
    let gone = false;
    const draw = () => {
      cancelAnimationFrame(drawing);
      if (gone) return;
      drawing = requestAnimationFrame(() => {
        if (gone) return;
        bindCanvasFrames();
        const labels = BREAKPOINTS.frames;
        setPlaced(visual.Canvas.getFrames().map((frame, at) => {
          const rect = visual.Canvas.getWorldRectToScreen(boxOf(frame));
          return { id: String(frame.id ?? at), label: labels[at] ? `${labels[at].label} · ${labels[at].width}` : `${frame.width}`, x: rect?.x ?? 0, y: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 };
        }));
        setZoom(Math.round(visual.Canvas.getZoom()));
        setPeerSpots(placePeers(visual, peersRef.current));
      });
    };
    visual.on('load', () => {
      const page = visual.Pages.getSelected();
      const main = page?.getFrames().at(0);
      if (page && main) {
        let x = first.width + BREAKPOINTS.gap;
        page.getFrames().add(others.map(size => {
          const frame = { refFrame: main, width: size.width, height: size.height, x, y: 0 };
          x += size.width + BREAKPOINTS.gap;
          return frame;
        }));
      }
      readLayers();
      requestAnimationFrame(() => {
        if (gone) return;
        mountHeadStyles(); showPrimary(); draw();
        markupAtRest.current = visual.getHtml();
        onReadyRef.current?.(true);
      });
    });
    visual.on('component:add component:remove component:update', () => readLayers());
    visual.on('canvas:coords canvas:zoom canvas:update canvas:frame:load', draw);
    visual.on('canvas:frame:load:head canvas:frame:load', mountHeadStyles);
    visual.on('canvas:coords canvas:zoom', () => { if (!fitting.current) moved.current = true; });
    visual.on('canvas:pointer', () => onPointerRef.current?.(visual.Canvas.getPointer()));
    const updateSelection = (component: Component | null) => {
      if (component) lastSelected.current = component;
      setSelected(component);
      setStyle(component ? { ...component.getStyle() } as Record<string, string> : {});
      const element = component?.getEl();
      const page = pages.find(row => row.id === selectedPage);
      onSelectionRef.current?.(element ? captureVisualSelection(element, { pagePath: page?.htmlPath ?? selectedPage ?? 'index.html', route: page?.route, revision: revisionNow.current }) : null);
    };
    visual.on('component:selected', updateSelection);
    visual.on('component:deselected', () => updateSelection(null));
    visual.on('component:toggled', () => setPickedCount(visual.getSelectedAll().length));
    const resized = new ResizeObserver(() => {
      fitPanels();
      if (!moved.current) (fitMode.current === 'all' ? showAll() : showFrame(fitMode.current));
      draw();
    });
    resized.observe(host.current);
    const left = () => onPointerRef.current?.(null);
    host.current.addEventListener('pointerleave', left);
    const element = host.current;
    const canvasDropHandlers = new Map<Document, { over: (event: DragEvent) => void; drop: (event: DragEvent) => void; frame: Frame }>();
    const frameLoadHandlers = new Map<HTMLIFrameElement, () => void>();
    const placeLibraryItem = (itemId: string, target: Component) => {
      const item = libraryItemsRef.current.find(row => row.id === itemId && row.canDrag && row.onChoose);
      if (!item) return false;
      visual.select(target);
      item.onChoose!();
      return true;
    };
    const attachDocumentDrop = (frame: Frame, iframe: HTMLIFrameElement) => {
      const document = iframe.contentDocument;
      if (!document || canvasDropHandlers.has(document)) return;
      const over = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes('application/x-trillion-library-item')) return;
        event.preventDefault();
        event.stopPropagation();
      };
      const drop = (event: DragEvent) => {
        const itemId = event.dataTransfer?.getData('application/x-trillion-library-item');
        if (!itemId || !event.target || (event.target as Node).nodeType !== Node.ELEMENT_NODE) return;
        event.preventDefault();
        event.stopPropagation();
        const target = event.target as Element;
        let component: Component | null = target === document.body || target === document.documentElement ? visual.getWrapper() : null;
        for (const candidate of visual.getWrapper()?.find('*').slice().reverse() ?? []) {
          const node = candidate.getEl(frame);
          if (node && (node === target || node.contains(target))) { component = candidate; break; }
        }
        // Unmapped/blank canvas space is a deliberate root placement. Selecting the wrapper clears any older selection,
        // so this never silently uses a stale page target.
        placeLibraryItem(itemId, component ?? visual.getWrapper());
      };
      document.addEventListener('dragover', over, true);
      document.addEventListener('drop', drop, true);
      canvasDropHandlers.set(document, { over, drop, frame });
    };
    const attachCanvasDrop = (frame?: Frame, iframe = frame?.view?.getEl()) => {
      if (!frame || !iframe) return;
      attachDocumentDrop(frame, iframe);
      if (frameLoadHandlers.has(iframe)) return;
      const loaded = () => attachDocumentDrop(frame, iframe);
      iframe.addEventListener('load', loaded);
      frameLoadHandlers.set(iframe, loaded);
    };
    const bindCanvasFrames = () => {
      const frames = visual.Canvas.getFrames();
      host.current?.querySelectorAll<HTMLIFrameElement>('iframe.gjs-frame').forEach(iframe => {
        const frame = frames.find(candidate => candidate.view?.getEl() === iframe);
        if (frame) attachCanvasDrop(frame, iframe);
      });
    };
    bindCanvasFrames();
    const frameObserver = new MutationObserver(bindCanvasFrames);
    frameObserver.observe(host.current, { childList: true, subtree: true });
    const onFrameLoad = (event: { model?: Frame; el?: HTMLIFrameElement; view?: { getEl?: () => HTMLIFrameElement } }) => {
      const frame = event.model ?? visual.Canvas.getFrames().find(candidate => candidate.view?.getEl() === event.el);
      attachCanvasDrop(frame, event.el ?? event.view?.getEl?.() ?? frame?.view?.getEl());
      bindCanvasFrames();
    };
    visual.on('canvas:frame:load', onFrameLoad);
    editor.current = visual;
    return () => {
      gone = true;
      for (const [document, handlers] of canvasDropHandlers) {
        document.removeEventListener('dragover', handlers.over, true);
        document.removeEventListener('drop', handlers.drop, true);
      }
      for (const [iframe, loaded] of frameLoadHandlers) iframe.removeEventListener('load', loaded);
      frameObserver.disconnect();
      visual.off('canvas:frame:load', onFrameLoad);
      cancelAnimationFrame(drawing); resized.disconnect(); element.removeEventListener('pointerleave', left);
      editor.current = null; onReadyRef.current?.(false); visual.destroy(); setSelected(null);
    };
  }, [openKey, engine]);

  // Update draft resources without replacing the canvas or unsaved work.
  useEffect(() => { mountResourceBase(); }, [baseUrl, openKey, engine]);

  // Someone else moved or changed what they are doing: draw them again where they are now.
  useEffect(() => {
    const visual = editor.current;
    if (visual) setPeerSpots(placePeers(visual, peers));
  }, [peers]);

  useImperativeHandle(ref, () => ({
    // GrapesJS marks frame setup as dirty on imported pages and updates parts as they are selected, so only markup that
    // differs from the page at rest (or a style change) counts as an edit that a route change must keep.
    hasUnsavedChanges: () => styleChanged.current || Boolean(editor.current && markupAtRest.current !== null && markupChanged(markupAtRest.current, editor.current.getHtml())),
    takeChanges: (nextHtml, nextCss, nextRenderCss = nextCss) => {
      const visual = editor.current;
      if (!visual) return false;
      const styles = nextCss !== originalCss.current;
      if (styles && styleChanged.current) return false;
      const parse = (text: string) => new DOMParser().parseFromString(text, 'text/html');
      const base = parse(original.current); const next = parse(nextHtml); const mine = parse(visual.getHtml());
      const addressed = (doc: Document) => Array.from(doc.body.querySelectorAll('[data-trillion-element]'));
      const order = (doc: Document) => addressed(doc).map(node => `${node.parentElement?.closest('[data-trillion-element]')?.getAttribute('data-trillion-element') ?? ''}>${node.getAttribute('data-trillion-element')}`).join(' ');
      // Parts moved, added or removed here are kept; parts moved, added or removed elsewhere open the page again.
      if (order(base) !== order(next)) return false;
      const at = (doc: Document, address: string) => doc.body.querySelector(`[data-trillion-element="${address}"]`);
      const ownText = (node: Element) => Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
      // A part's own facts: its attributes named on either side, its own words, and its markup when it holds no parts.
      const facts = (node: Element, names: string[]) => JSON.stringify([names.map(name => node.getAttribute(name)), ownText(node), node.querySelector('[data-trillion-element]') ? null : node.innerHTML.replace(/\s+/g, ' ').trim()]);
      const changes: { address: string; node: Element; names: string[] }[] = [];
      for (const node of addressed(next)) {
        const address = node.getAttribute('data-trillion-element') ?? '';
        const was = at(base, address); const here = at(mine, address);
        if (!was || !here) return false;
        // The editor keeps inline styles as rules and names styled parts with ids, so neither is compared here; a style
        // attribute changed elsewhere is not taken in place.
        if (was.getAttribute('style') !== node.getAttribute('style')) return false;
        const names = [...new Set([...was.getAttributeNames(), ...node.getAttributeNames()])].filter(name => name !== 'id' && name !== 'style').sort();
        if (facts(was, names) === facts(node, names)) continue;
        if (facts(here, names) !== facts(was, names)) return false;
        if (node.querySelector('[data-trillion-element]') && ownText(node) !== ownText(was)) return false;
        changes.push({ address, node, names });
      }
      const unsaved = markupAtRest.current !== null && markupChanged(markupAtRest.current, visual.getHtml());
      for (const { address, node, names } of changes) {
        const component = visual.getWrapper()?.find(`[data-trillion-element="${address}"]`)[0];
        if (!component) return false;
        const gone = names.filter(name => name !== 'class' && !node.hasAttribute(name));
        if (gone.length) component.removeAttributes(gone);
        component.addAttributes(Object.fromEntries(node.getAttributeNames().filter(name => name !== 'class' && name !== 'id' && name !== 'style').map(name => [name, node.getAttribute(name) ?? ''])));
        component.setClass(Array.from(node.classList));
        if (!node.querySelector('[data-trillion-element]')) component.components(node.innerHTML);
      }
      if (styles) { visual.setStyle(nextRenderCss); originalCss.current = nextCss; }
      if (!unsaved) markupAtRest.current = visual.getHtml();
      original.current = nextHtml;
      adopted.current = nextHtml;
      return true;
    },
    placeCapability: (placementId, label) => {
      const visual = editor.current;
      if (!visual || !/^[a-z][a-z0-9-]{1,79}$/.test(placementId)) return false;
      const existing = visual.getWrapper().find(`[data-trillion-placement="${placementId}"]`)[0];
      if (existing) { visual.select(existing); return true; }
      const pageContent = capabilityContainer(visual, lastSelected.current);
      const added = pageContent.append({ tagName: 'div', attributes: { 'data-trillion-placement': placementId, class: 'trillion-capability-slot' },
        components: [{ type: 'text', content: label }] });
      if (added?.[0]) visual.select(added[0]);
      return Boolean(added?.[0]);
    },
    placeImageAsset: (url, alt) => {
      const visual = editor.current;
      if (!visual || !/^\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(url) ||
          url.split('/').some(part => part === '.' || part === '..')) return false;
      const added = capabilityContainer(visual, lastSelected.current).append({ type: 'image', attributes: { src: url, alt, loading: 'lazy' } });
      if (added?.[0]) visual.select(added[0]);
      return Boolean(added?.[0]);
    },
    bindSelectedForm: actionPath => {
      let component = editor.current?.getSelected() ?? null;
      while (component && String(component.get('tagName')).toLowerCase() !== 'form') component = component.parent() ?? null;
      if (!component) return false;
      component.addAttributes({ action: actionPath, method: 'post' });
      editor.current?.select(component);
      return true;
    },
    exportFiles: () => {
      if (!editor.current) throw new Error('The visual editor is still opening.');
      const document = new DOMParser().parseFromString(original.current, 'text/html');
      const edited = new DOMParser().parseFromString(editor.current.getHtml(), 'text/html');
      // GrapesJS renders imported body styles in its frames but omits them from
      // getHtml(). Keep each original style beside its addressed content so a
      // saved visual edit does not silently remove the site's design.
      const bodyStyles = Array.from(document.body.querySelectorAll('style')).map(node => {
        const parent = node.parentElement;
        const parentAddress = parent === document.body ? null : parent?.closest('[data-trillion-element]')?.getAttribute('data-trillion-element') ?? null;
        let next = node.nextElementSibling;
        while (next && !next.getAttribute('data-trillion-element')) next = next.nextElementSibling;
        return { node, parentAddress, nextAddress: next?.getAttribute('data-trillion-element') ?? null };
      });
      // Scripts in the original body are app behavior, so keep them as the
      // visual canvas changes only the rendered content around them.
      const scripts = Array.from(document.body.querySelectorAll('script')).map(node => node.cloneNode(true));
      document.body.replaceChildren(...Array.from(edited.body.childNodes).map(node => document.importNode(node, true)), ...scripts);
      document.body.querySelectorAll('style').forEach(node => node.remove());
      for (const { node, parentAddress, nextAddress } of bodyStyles) {
        const parent = parentAddress ? document.body.querySelector(`[data-trillion-element="${parentAddress}"]`) ?? document.body : document.body;
        const before = nextAddress ? Array.from(parent.children).find(child => child.getAttribute('data-trillion-element') === nextAddress) ?? null : null;
        parent.insertBefore(node, before);
      }
      if (document.body.querySelector('[data-trillion-placement]')) {
        if (!document.head.querySelector('link[href="/capabilities/runtime.css"]')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet'; link.href = '/capabilities/runtime.css'; document.head.append(link);
        }
        if (!document.body.querySelector('script[src="/capabilities/runtime.js"]')) {
          const script = document.createElement('script');
          script.src = '/capabilities/runtime.js'; script.defer = true; document.body.append(script);
        }
      }
      return { html: `<!doctype html>\n${document.documentElement.outerHTML}`, css: styleChanged.current ? editor.current.getCss() : originalCss.current };
    },
  }), []);

  const chooseLayer = (id: string) => { const component = components.current.get(id); if (component) editor.current?.select(component); };
  const pointAtLayer = (id: string | null) => {
    const model = editor.current?.getModel() as unknown as { setHovered?: (component?: Component | null) => void } | undefined;
    model?.setHovered?.(id ? components.current.get(id) ?? null : null);
  };
  const moveLayer = (move: LayerTreeMove) => {
    const visual = editor.current;
    const component = components.current.get(move.id);
    const into = move.parentId ? components.current.get(move.parentId) : visual?.getWrapper();
    if (!visual || !component || !into) return;
    const children = into.components();
    const currentIndex = component.parent() === into ? children.indexOf(component) : -1;
    // LayerTree's index is the insertion slot after removing the dragged row. GrapesJS
    // resolves `at` against the current collection, so moving forward in one parent
    // needs the slot after the original source position.
    const at = currentIndex >= 0 && currentIndex < move.index ? move.index + 1 : move.index;
    component.move(into, { at });
    visual.select(component);
  };
  const focusFrame = (at: number) => showFrame(at);
  const pageName = pages.find(page => page.id === selectedPage)?.label ?? 'Home';
  const addableItems: EditorLibraryItem[] = [
    { id: 'block:section', label: 'Section', group: 'Layout', detail: 'Add a new area to this page.', action: 'Add to page', onChoose: () => add('section') },
    { id: 'block:text', label: 'Text', group: 'Content', detail: 'Add editable words to this page.', action: 'Add to page', onChoose: () => add('text') },
    { id: 'block:image', label: 'Image', group: 'Media', detail: 'Add an image area to this page.', action: 'Add to page', onChoose: () => add('image') },
    ...libraryItems,
  ];
  const libraryCategories = [...new Set(addableItems.map(item => item.group))].sort((a, b) => a.localeCompare(b));
  const matchingLibraryItems = addableItems.filter(item => (libraryCategory === 'all' || item.group === libraryCategory)
    && `${item.label} ${item.group} ${item.context ?? ''} ${item.detail ?? ''}`.toLowerCase().includes(librarySearch.trim().toLowerCase()));
  const libraryGroups = libraryCategories.flatMap(group => {
    const items = matchingLibraryItems.filter(item => item.group === group);
    return items.length ? [{ group, items }] : [];
  });

  if (engineDownload.status === 'failed') return <ScreenState state={{ status: 'failed', title: 'The page editor could not open', description: 'Your page is still here. Try opening the editor again.', retry: { label: 'Try again', run: engineDownload.retry } }} />;
  if (engineDownload.status !== 'loaded') return <ScreenState state={{ status: 'loading', label: 'Opening the page editor', layout: 'editor' }} />;

  return <div className="trillion-visual-editor" aria-label="Visual app editor">
    <div className="trillion-visual-editor__body" ref={editorBody} style={{ '--editor-rail-width': `${EDITOR_LAYOUT.rail}px`, '--editor-library-width': `${panelWidths.library}px`, '--editor-inspector-width': `${panelWidths.inspector}px` } as React.CSSProperties}>
      <div className="trillion-visual-editor__tool-rail" role="toolbar" aria-label="Page tools">
        {EDITOR_LAYOUT.tabs.map(tab => <Button key={tab.id} size="icon" variant="ghost" active={leftView === tab.id}
          aria-label={tab.label} aria-pressed={leftView === tab.id} title={tab.label}
          onKeyDown={event => {
            const at = EDITOR_LAYOUT.tabs.findIndex(item => item.id === tab.id);
            const move = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
            if (!move) return;
            event.preventDefault();
            const id = EDITOR_LAYOUT.tabs[(at + move + EDITOR_LAYOUT.tabs.length) % EDITOR_LAYOUT.tabs.length].id;
            const next = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-editor-tool="${id}"]`);
            next?.focus(); next?.click();
          }} data-editor-tool={tab.id} onClick={() => setLeftView(tab.id as typeof leftView)}>
          <NamedIcon name={tab.icon} size="sm" aria-hidden="true" />
        </Button>)}
      </div>
      <aside className="trillion-visual-editor__library" aria-label="Page tools">
        <div className="trillion-visual-editor__panel-heading"><h2>{EDITOR_LAYOUT.tabs.find(tab => tab.id === leftView)?.label}</h2>
          <span>{leftView === 'layers' ? pageName : leftView === 'library' ? `${addableItems.length} items` : 'Shared library'}</span></div>
        {pages.length > 1 ? <Select value={selectedPage} onValueChange={value => { if (typeof value === 'string') onChoosePage?.(value); }}>
          <SelectTrigger aria-label="Page"><SelectValue>{pageName}</SelectValue></SelectTrigger>
          <SelectPopup>{pages.map(page => <SelectItem key={page.id} value={page.id}>{page.label}</SelectItem>)}</SelectPopup>
        </Select> : null}
        <div className="trillion-visual-editor__panel-content" hidden={leftView !== 'layers'}>
          <LayerTree key={openKey} label={`Layers of ${pageName}`} nodes={layers} selectedId={selected?.cid ?? null} onSelect={chooseLayer} onHover={pointAtLayer} onMove={moveLayer} />
        </div>
        <div className="trillion-visual-editor__panel-content" hidden={leftView !== 'library'}>
          <SearchField label="Search library" placeholder="Search sections, tools and files" value={librarySearch} onChange={event => setLibrarySearch(event.currentTarget.value)} />
          <Select value={libraryCategory} onValueChange={value => { if (typeof value === 'string') setLibraryCategory(value); }}>
            <SelectTrigger aria-label="Category"><SelectValue>{libraryCategory === 'all' ? 'All categories' : libraryCategory}</SelectValue></SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All categories ({addableItems.length})</SelectItem>
              {libraryCategories.map(category => <SelectItem key={category} value={category}>{category} ({addableItems.filter(item => item.group === category).length})</SelectItem>)}
            </SelectPopup>
          </Select>
          <div className="trillion-visual-editor__library-results">
            {!matchingLibraryItems.length ? <p role="status">No items match this search.</p> : libraryGroups.map(({ group, items }) => <section className="trillion-visual-editor__library-group" key={group} aria-label={group}>
              <h3>{group}<span>{items.length}</span></h3>
              {items.map(item => <div className="trillion-visual-editor__library-result" key={item.id} draggable={Boolean(item.canDrag && item.onChoose)}
                onDragStart={event => {
                  if (!item.canDrag || !item.onChoose) { event.preventDefault(); return; }
                  event.dataTransfer.setData('application/x-trillion-library-item', item.id);
                  event.dataTransfer.effectAllowed = 'copy';
                }}>
                <strong>{item.label}</strong>{item.context ? <small>{item.context}</small> : null}{item.detail ? <p>{item.detail}</p> : null}
                {item.onChoose ? <Button size="sm" variant="secondary" onClick={item.onChoose}>{item.action ?? 'Open'}</Button> : null}
              </div>)}
            </section>)}
          </div>
        </div>
        <div className="trillion-visual-editor__panel-content" hidden={leftView !== 'sources'}>
          <p>Screen studies are references and observations. Check a component's license before using its code.</p>
          <SearchField label="Search references" placeholder="Search studied screens" value={referencesQuery} onChange={event => onSearchReferences?.(event.currentTarget.value)} />
          <div className="trillion-visual-editor__source-catalog">
            <strong>21st.dev components</strong>
            <p>Browse the catalog. Trillion does not search 21st.dev here; check each item's license and terms before reusing code.</p>
            <Button size="sm" variant="secondary" onClick={() => window.open('https://21st.dev/community/components', '_blank', 'noopener,noreferrer')}>Browse 21st.dev ↗</Button>
          </div>
          {referencesStatus === 'loading' ? <p role="status">Searching shared references…</p> : null}
          {referencesStatus === 'failed' ? <p role="status">Shared references are unavailable right now.</p> : null}
          {referencesStatus === 'ready' && !references.length ? <p>No studied screens match this search.</p> : null}
          <div className="trillion-visual-editor__library-results">
            {references.map(reference => <div className="trillion-visual-editor__library-result" key={reference.id}>
              <small>{reference.app} · {reference.platform} · {reference.screenKind}</small>
              <strong>{reference.title}</strong>
              <p>{reference.anatomy}</p>
              {reference.patterns.length ? <p>Patterns: {reference.patterns.join(' · ')}</p> : null}
              {/^https:\/\//i.test(reference.sourceUrl) ? <Button size="sm" variant="secondary" onClick={() => window.open(reference.sourceUrl, '_blank', 'noopener,noreferrer')}>Open original reference ↗</Button> : null}
            </div>)}
          </div>
        </div>
        {panelDivider('library')}
      </aside>
      <div className="trillion-visual-editor__stage">
        <div className="trillion-visual-editor__canvas" ref={host} aria-label="Page canvas" />
        <div className="trillion-visual-editor__overlay" aria-hidden={false}>
          {placed.map((frame, at) => frame.width < 48 ? null : <Button key={frame.id} size="xs" variant="ghost" className="trillion-visual-editor__frame-label" style={{ left: frame.x, top: Math.max(4, frame.y - 26), maxWidth: frame.width }} onClick={() => focusFrame(at)}>{frame.label}</Button>)}
          {stackedBoxes(peerSpots).map(({ peer, box, at, row }) => <div key={`${peer.id}-box-${at}`} className="trillion-visual-editor__peer-box" data-peer-element={peer.target?.element ?? ''} style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderColor: peer.color }}>
            <span className="trillion-visual-editor__peer-box-name" style={{ background: peer.color, marginBottom: 2 + row * PEER_NAME_ROW }}>{peer.doing ? `${peer.name} · ${peer.doing}` : peer.name}</span>
          </div>)}
          {peerSpots.filter(peer => peer.cursor || !peer.boxes.length).map(peer => <div key={peer.id} className="trillion-visual-editor__peer" style={{ left: peer.at.x, top: peer.at.y, color: peer.color }}>
            <NamedIcon name="MousePointer2" size="md" aria-hidden="true" />
            <span className="trillion-visual-editor__peer-name" style={{ background: peer.color }}>{peer.doing ? `${peer.name} · ${peer.doing}` : peer.name}</span>
          </div>)}
        </div>
        <div className="trillion-visual-editor__dock" role="toolbar" aria-label="Canvas">
          <Button size="xs" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><NamedIcon name="Minus" size="sm" /></Button>
          <Button size="xs" variant="ghost" aria-label="Show every size" onClick={() => showAll()}>{zoom}%</Button>
          <Button size="xs" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><NamedIcon name="Plus" size="sm" /></Button>
          <Button size="xs" variant="ghost" aria-label="Undo" onClick={() => editor.current?.UndoManager.undo()}><NamedIcon name="Undo2" size="sm" /></Button>
          <Button size="xs" variant="ghost" aria-label="Redo" onClick={() => editor.current?.UndoManager.redo()}><NamedIcon name="Redo2" size="sm" /></Button>
          <Button size="xs" variant="ghost" active={preview} onClick={() => { editor.current?.runCommand(preview ? 'stop-preview' : 'preview'); setPreview(!preview); }}>{preview ? 'Edit' : 'Preview'}</Button>
        </div>
      </div>
      <aside className="trillion-visual-editor__inspector" aria-label="Selected element">
        {panelDivider('inspector')}
        <div className="trillion-visual-editor__panel-heading"><h2>{selected ? layerLabel({ tag: String(selected.get('tagName') ?? 'div'), text: textOf(selected), alt: selected.getAttributes().alt, className: selected.getAttributes().class }).name : 'Properties'}</h2>
          {selected ? <span>{String(selected.get('tagName') ?? '')}</span> : null}</div>
        <div className="trillion-visual-editor__panel-content">
        {selected ? <>
          {SCOPES.length > 1 ? <SegmentedControl ariaLabel="Change" value={scope?.id ?? ''} onValueChange={setScopeId}
            items={SCOPES.map(row => ({ id: row.id, label: row.id === scope?.id ? `${row.label} · ${reached.length}` : row.picked ? `${row.label} · ${Math.max(1, pickedCount)}` : row.label }))} /> : null}
          <TuningPanel search={EDITOR_LAYOUT.properties_search} sections={STYLE_SETTINGS.sections} values={styleValues(selected, style)} onChange={(key, value) => {
            const setting = STYLE_SETTING_BY_KEY.get(key);
            if (setting && value !== undefined) changeStyle(key, settingToCss(setting, value));
          }} />
          {selectionPanel}
        </> : <div className="trillion-visual-editor__empty-selection"><NamedIcon name="MousePointer2" size="lg" aria-hidden="true" /><p>Select something on the page or in the layers to change it.</p></div>}
        </div>
      </aside>
    </div>
  </div>;
});

/** Each outline to draw, with the row its name takes: several people on the same part have their names stacked above
 *  it, one row each, the way Figma shows two people selecting one layer. */
const PEER_NAME_ROW = 20;
function stackedBoxes(peers: PlacedPeer[]): { peer: PlacedPeer; box: Box; at: number; row: number }[] {
  const taken = new Map<string, number>();
  return peers.flatMap(peer => peer.boxes.map((box, at) => {
    const spot = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`;
    const row = taken.get(spot) ?? 0;
    taken.set(spot, row + 1);
    return { peer, box, at, row };
  }));
}

/** Whether the page's markup changed from `rest`. The editor gives a part a generated id when it is picked or styled; an
 *  id the part did not have at rest is not an edit (a style change is counted on its own). */
function markupChanged(rest: string, now: string): boolean {
  const restDoc = new DOMParser().parseFromString(rest, 'text/html');
  const nowDoc = new DOMParser().parseFromString(now, 'text/html');
  nowDoc.body.querySelectorAll('[id][data-trillion-element]').forEach(node => {
    const was = restDoc.body.querySelector(`[data-trillion-element="${node.getAttribute('data-trillion-element')}"]`);
    if (was && !was.hasAttribute('id')) node.removeAttribute('id');
  });
  return nowDoc.body.innerHTML !== restDoc.body.innerHTML;
}

/** Where each other person or AI is drawn: their pointer, and an outline around what they are changing in every frame
 *  that shows it (each size of the page), found by its address, else its selector, else its words. */
function placePeers(visual: Editor, peers: CanvasPeer[]): PlacedPeer[] {
  const frames = visual.Canvas.getFrames();
  const toScreen = (world: Box) => visual.Canvas.getWorldRectToScreen(world);
  const find = (doc: Document, target: NonNullable<CanvasPeer['target']>): Element | null => {
    const address = target.element && /^e[0-9a-z]+$/.test(target.element) ? target.element : null;
    let element = address ? doc.querySelector(`[data-trillion-element="${address}"]`) : null;
    if (!element && target.selector) { try { element = doc.querySelector(target.selector); } catch { element = null; } }
    if (!element && target.text) {
      const words = target.text.replace(/\s+/g, ' ').trim();
      const all = words ? Array.from(doc.body.querySelectorAll('*')).filter(node => (node.textContent ?? '').replace(/\s+/g, ' ').includes(words)) : [];
      element = all[all.length - 1] ?? null;
    }
    return element;
  };
  const placed: PlacedPeer[] = [];
  for (const peer of peers) {
    const boxes: Box[] = [];
    if (peer.target) {
      for (const frame of frames) {
        const doc = frame.view?.getDoc();
        const element = doc?.body ? find(doc, peer.target) : null;
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const box = toScreen({ x: Number(frame.get('x') ?? 0) + rect.x, y: Number(frame.get('y') ?? 0) + rect.y, width: rect.width, height: rect.height });
        if (box && box.width > 0) boxes.push({ x: box.x, y: box.y, width: box.width, height: box.height });
      }
    }
    const pointer = peer.cursor ? toScreen({ x: peer.cursor.x, y: peer.cursor.y, width: 0, height: 0 }) : null;
    const first = boxes[0];
    const at = pointer ?? (first ? { x: first.x + Math.min(first.width / 2, 40), y: first.y + Math.min(first.height / 2, 16) } : null);
    if (!at) continue;
    placed.push({ ...peer, at: { x: at.x, y: at.y }, boxes });
  }
  return placed;
}
