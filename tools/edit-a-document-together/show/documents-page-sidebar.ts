// packages/documents/show/documents-page-sidebar.ts
//
// The Documents page-rail projection. Page scene nodes remain the SSOT; this adapter emits the shared sidebar's own
// sections (the recursive rows every embedded list draws, as Messages and Record do) and the same rows as catalog items.

import { projectedNavItemsToCatalogItems } from '../../sidebar/show/ProjectedCollectionNav.ts';
import type { ActionMenuItem } from '../../ui';
import pageActionRows from '../data/page-actions.json' with { type: 'json' };
import type { NavItemActionData, NavSectionData } from '../../sidebar/show/SidebarContent';
import type { DocumentPageBacklink, PageReference } from '../read-data/page-references';
import { parseInlineRuns } from '../read-data/inline-tokens.ts';
import { headingLevel } from '../read-data/heading-semantics.ts';
import type { DocumentIndexEntry } from '../read-data/document-index.ts';

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
  orderIndex?: number;
  orderCount?: number;
  headings?: readonly { id: string; label: string; level: number }[];
  referencesToCheck?: readonly PageReference[];
  backlinks?: readonly DocumentPageBacklink[];
  backlinksTitle?: string;
  missingReferenceLabel?: string;
  pageReferenceKind?: string;
  saveLabel?: string;
  canRetrySave?: boolean;
}

export interface DocumentsPageSceneRouting {
  sceneAddress: string;
  sceneAddressMode: 'identity_text' | 'label_hash';
  spaceId?: string;
}

export function documentBacklinkDestination(pages: readonly DocumentsSidebarPage[], backlinkId: string) {
  for (const page of pages) {
    const backlink = page.backlinks?.find(row => row.id === backlinkId);
    if (backlink) return { pageId: backlink.sourcePageId, blockId: backlink.blockId };
  }
  return null;
}

interface OutlineNode { id: string; props?: unknown; children?: readonly OutlineNode[] }

/** Read heading semantics from the authored scene, never from visual font size. */
export function documentHeadings(node: OutlineNode) {
  const headings: { id: string; label: string; level: number }[] = [];
  const visit = (child: typeof node) => {
    const props = child.props as { text?: unknown; custom?: { heading_level?: unknown } } | undefined;
    const level = headingLevel(props);
    if (level !== null) {
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

// Both the page menu and shared sidebar read the same package DATA. Availability
// follows the current scene order; no second ordering record is introduced.
type DocumentsPageAction = Omit<NavItemActionData, 'items'> & {
  history?: boolean;
  order?: { offset?: number; edge?: string };
  items?: DocumentsPageAction[];
};
export const DOCUMENTS_PAGE_ACTIONS = pageActionRows as DocumentsPageAction[];

export function documentPageMoveTarget(actionId: string, index: number, count: number): number | null {
  const find = (rows: DocumentsPageAction[]): DocumentsPageAction | undefined => {
    for (const row of rows) { if (row.id === actionId) return row; const nested = row.items && find(row.items); if (nested) return nested; }
  };
  const order = find(DOCUMENTS_PAGE_ACTIONS)?.order;
  if (!order) return null;
  const target = typeof order.offset === 'number' ? index + order.offset
    : order.edge === 'start' ? 0 : order.edge === 'end' ? count - 1 : -1;
  return Number.isInteger(target) && target >= 0 && target < count && target !== index ? target : null;
}

export function documentsPageActions(index: number, count: number, historyAvailable: boolean): NavItemActionData[] {
  const project = (rows: DocumentsPageAction[]): NavItemActionData[] => rows.flatMap(row => {
    if (row.history && !historyAvailable) return [];
    if (row.order && documentPageMoveTarget(row.id, index, count) === null) return [];
    const items = row.items ? project(row.items) : undefined;
    if (items && !items.length) return [];
    const { history, order, items: declaredItems, ...action } = row;
    return [{ ...action, ...(items ? { items } : {}) }];
  });
  return project(DOCUMENTS_PAGE_ACTIONS);
}

export function documentsPageMenuItems(actions: readonly NavItemActionData[]): ActionMenuItem[] {
  return actions.map(action => ({ ...action, id: `page:${action.id}`,
    ...(action.items ? { items: documentsPageMenuItems(action.items) } : {}) }));
}

export function documentsPagesToNavItems(
  pages: readonly DocumentsSidebarPage[],
  routing?: DocumentsPageSceneRouting,
  historyAvailable = false,
) {
  return pages.map((page, index) => {
    const orderIndex = page.orderIndex ?? index;
    const orderCount = page.orderCount ?? pages.length;
    return ({
    id: page.id,
    label: page.label,
    icon: 'FileText',
    ...(routing ? {
      placeableSurface: true,
      packageEntry: { packageName: 'documents', entryName: 'documents' },
      navigation: 'local' as const,
      surfaceInput: {
        scene_address: routing.sceneAddress,
        scene_address_mode: routing.sceneAddressMode,
        initial_page_id: page.id,
        ...(routing.spaceId ? { space_id: routing.spaceId } : {}),
      },
    } : {}),
    ...(page.saveLabel ? { badge: page.saveLabel } : {}),
    actions: [
      ...(page.canRetrySave ? [{ id: 'retry-save', label: 'Retry save', icon: 'RefreshCw' }] : []),
      ...documentsPageActions(orderIndex, orderCount, historyAvailable),
    ],
  });
  });
}

export function buildDocumentsPageSidebarProjection(pages: readonly DocumentsSidebarPage[], routing?: DocumentsPageSceneRouting, historyAvailable = false) {
  const items = documentsPagesToNavItems(pages, routing, historyAvailable);
  const itemsById = new Map(items.map(item => [item.id, item]));
  // Reuse the sidebar's caller-owned nested sections; no second page store.
  const sections: NavSectionData[] = pages.some(page => page.headings?.length || page.referencesToCheck?.length || page.backlinks?.length)
    ? [{ id: 'documents-pages-outline', title: 'Pages', items: [], sections: pages.map(page => ({
      id: `page-outline:${page.id}`,
      ownerSurfaceId: page.id,
      items: projectedNavItemsToCatalogItems([itemsById.get(page.id)!]),
      sections: [...(page.headings?.length ? [{
        id: `headings:${page.id}`,
        items: page.headings.map(heading => ({ id: heading.id, viewId: heading.id, label: heading.label, icon: 'Heading', badge: `H${heading.level}` })),
      }] : []), ...(page.referencesToCheck?.length ? [{
        id: `references:${page.id}`,
        title: 'References to check',
        items: page.referencesToCheck.map(reference => ({
          id: reference.id, viewId: reference.id, label: `@${reference.reference.label}`,
          icon: 'Link', badge: reference.resolution === 'missing'
            ? reference.reference.kind === page.pageReferenceKind ? page.missingReferenceLabel ?? 'Not found' : 'Not found'
            : 'Not checked',
        actions: [{ id: 'check-references', label: 'Check again', icon: 'RefreshCw' }],
        })),
      }] : []), ...(page.backlinks?.length ? [{
        id: `backlinks:${page.id}`,
        title: page.backlinksTitle ?? 'Backlinks',
        items: page.backlinks.map(backlink => ({
          id: backlink.id,
          viewId: backlink.id,
          label: `${backlink.sourcePageLabel} · @${backlink.reference.label}`,
          icon: 'Link',
        })),
      }] : [])],
    })) }]
    : [{ id: DOCUMENTS_PAGE_COLLECTION_ID, title: 'Pages', items: projectedNavItemsToCatalogItems(items) }];
  return { sections, catalogItems: projectedNavItemsToCatalogItems(items) };
}

/** The same indexed rows feed the visible library, saved-list manager and shared opening controls. */
export function buildDocumentsLibrarySidebarProjection(
  pages: ReturnType<typeof buildDocumentsPageSidebarProjection>,
  documents: readonly Pick<DocumentIndexEntry, 'doc_id' | 'title' | 'doc_address' | 'doc_address_mode' | 'document_revision_hash'>[],
) {
  const items = projectedNavItemsToCatalogItems(documents.map(entry => ({
    id: `indexed-document:${entry.doc_id}`, label: entry.title, icon: 'FileText',
    placeableSurface: true,
    packageEntry: { packageName: 'documents', entryName: 'documents' },
    navigation: 'local' as const,
    surfaceInput: {
      scene_address: entry.doc_address,
      scene_address_mode: entry.doc_address_mode ?? 'identity_text',
      expected_document_revision: entry.document_revision_hash,
    },
  })));
  return {
    sections: items.length ? [...pages.sections, { id: 'documents-library', title: 'Saved documents', items }] : pages.sections,
    catalogItems: [...pages.catalogItems, ...items],
  };
}
