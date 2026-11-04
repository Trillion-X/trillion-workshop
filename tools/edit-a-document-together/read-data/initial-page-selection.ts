export interface PageIdentity {
  id: string;
}

export interface InitialPageSelection {
  pageId: string | null;
  /** An explicit route that does not exist must not fall through to another page. */
  missingRequestedPage: boolean;
}

/** Resolve an explicit page route before a retained selection or the normal first-page default. */
export function resolveInitialPageSelection(
  pages: readonly PageIdentity[],
  requestedPageId?: string | null,
  retainedPageId?: string | null,
  applyRequestedPage = true,
): InitialPageSelection {
  const ids = new Set(pages.map((page) => page.id));
  if (typeof requestedPageId === 'string' && requestedPageId.length > 0) {
    if (applyRequestedPage) {
      return ids.has(requestedPageId)
        ? { pageId: requestedPageId, missingRequestedPage: false }
        : { pageId: null, missingRequestedPage: true };
    }
    if (requestedPageId === retainedPageId && !ids.has(requestedPageId)) {
      return { pageId: null, missingRequestedPage: true };
    }
  }
  if (retainedPageId && ids.has(retainedPageId)) return { pageId: retainedPageId, missingRequestedPage: false };
  return { pageId: pages[0]?.id ?? null, missingRequestedPage: false };
}
