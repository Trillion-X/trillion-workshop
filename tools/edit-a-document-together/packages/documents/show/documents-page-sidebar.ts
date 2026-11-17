// packages/documents/show/documents-page-sidebar.ts
//
// The Documents page-rail projection. Page scene nodes remain the SSOT; this
// adapter emits only the owned sidebar's projected group graph and catalog rows.

import {
  buildProjectedCollectionNav,
  projectedNavItemsToCatalogItems,
} from '../../../../organize-the-sidebar/show/ProjectedCollectionNav';
import type { NavSectionData } from '../../../../sidebar/show/SidebarContent';
import type { PageReference } from '../read-data/page-references';
import { parseInlineRuns } from '../read-data/inline-tokens';

export const DOCUMENTS_PAGE_SIDEBAR_SCOPE = 'documents-pages';
export const DOCUMENTS_PAGE_COLLECTION_ID = 'pages';

export const DOCUMENTS_SIDEBAR_ACTIONS = [
  { id: 'documents:new-page', label: 'New page', icon: 'Plus' },
  { id: 'documents:import-page', label: 'Import a page', icon: 'FileText' },
  { id: 'documents:all-pages', label: 'All pages', icon: 'Maximize2' },
] as const;

export interface DocumentsSidebarPage {
  id: string;
  label: string;
  headings?: readonly { id: string; label: string; level: number }[];
  selectedBlock?: { id: string; label: string };
  referencesToCheck?: readonly PageReference[];
  saveLabel?: string;
  canRetrySave?: boolean;
}

interface OutlineNode { id: string; props?: unknown; children?: readonly OutlineNode[] }

/** Read heading semantics from the authored scene, never from visual font size. */
export function documentHeadings(node: OutlineNode) {
  const headings: { id: string; label: string; level: number }[] = [];
  const visit = (child: typeof node) => {
    const props = child.props as { text?: unknown; custom?: { heading_level?: unknown } } | undefined;
    const level = props?.custom?.heading_level;
    if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6) {
      const label = typeof props?.text === 'string'
        ? parseInlineRuns(props.text).map(run => run.type === 'text' ? run.text : `@${run.label}`).join('').trim()
        : '';
      headings.push({ id: child.id, label: label || 'Untitled heading', level });
    }
    for (const nested of child.children ?? []) visit(nested);
  };
  for (const child of node.children ?? []) visit(child);
  return headings;
}

// Per-page row actions for the sidebar row menu. DATA only: each row is
// {id,label,icon} where icon is a lucide name the shared renderer resolves by
// name (icons-per-item, like the agents-hub card menus). Adding an action means
// adding a row here, and `onPageAction` maps the id to the same scene primitive
// a block uses. These rows moved out of DocumentsSurface when the documents-local
// rail was replaced by the owned sidebar, so there is one definition, not two.
export const DOCUMENTS_PAGE_ACTIONS = [
  { id: 'rename', label: 'Rename', icon: 'Pencil' },
  // Page-level spacing is the "global setting like Webflow" (The owner): editing the
  // PAGE container's gap sets the space between EVERY block at once (the engine
  // cascades it), and its padding insets the whole page. The block grip's own
  // Spacing edits one block.
  { id: 'spacing', label: 'Spacing…', icon: 'StretchVertical' },
  { id: 'check-references', label: 'Check references', icon: 'RefreshCw' },
  { id: 'duplicate', label: 'Duplicate', icon: 'Copy' },
  { id: 'move-to-top', label: 'Move to top', icon: 'ArrowUpToLine' },
  // The destructive row sits last and takes the shared menu's quiet destructive
  // tone (screen-look `--color-destructive-muted`) on its icon and label.
  { id: 'delete', label: 'Delete', icon: 'Trash2', tone: 'destructive' },
] as const;

export function documentsPagesToNavItems(
  pages: readonly DocumentsSidebarPage[],
) {
  return pages.map((page) => ({
    id: page.id,
    label: page.label,
    icon: 'FileText',
    ...(page.saveLabel ? { badge: page.saveLabel } : {}),
    actions: page.canRetrySave
      ? [{ id: 'retry-save', label: 'Retry save', icon: 'RefreshCw' }, ...DOCUMENTS_PAGE_ACTIONS]
      : DOCUMENTS_PAGE_ACTIONS,
  }));
}

export function buildDocumentsPageSidebarProjection(pages: readonly DocumentsSidebarPage[]) {
  const items = documentsPagesToNavItems(pages);
  // Reuse the sidebar's caller-owned nested sections; no second page store.
  const sections: NavSectionData[] | undefined = pages.some(page => page.headings?.length || page.selectedBlock || page.referencesToCheck?.length)
    ? [{ id: 'documents-pages-outline', title: 'Pages', items: [], sections: pages.map(page => ({
      id: `page-outline:${page.id}`,
      items: projectedNavItemsToCatalogItems(documentsPagesToNavItems([page])),
      sections: [...(page.headings?.length ? [{
        id: `headings:${page.id}`,
        items: page.headings.map(heading => ({ id: heading.id, viewId: heading.id, label: heading.label, icon: 'Heading', badge: `H${heading.level}` })),
      }] : []), ...(page.selectedBlock && !page.headings?.some(heading => heading.id === page.selectedBlock!.id) ? [{
        id: `selected-block:${page.id}`,
        title: 'Selected block',
        items: [{id: page.selectedBlock.id, viewId: page.selectedBlock.id, label: `Selected: ${page.selectedBlock.label}`, icon: 'Text'}],
      }] : []), ...(page.referencesToCheck?.length ? [{
        id: `references:${page.id}`,
        title: 'References to check',
        items: page.referencesToCheck.map(reference => ({
          id: reference.id, viewId: reference.id, label: `@${reference.reference.label}`,
          icon: 'Link', badge: reference.resolution === 'missing' ? 'Not found' : 'Not checked',
        })),
      }] : [])],
    })) }]
    : undefined;
  return {
    sections,
    catalogItems: projectedNavItemsToCatalogItems(items),
    graph: buildProjectedCollectionNav({
      scope: DOCUMENTS_PAGE_SIDEBAR_SCOPE,
      collectionId: DOCUMENTS_PAGE_COLLECTION_ID,
      collectionName: 'Pages',
      itemFamily: 'documents.scene-node',
      items,
    }),
  };
}
