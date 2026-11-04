export function activeTabIdAfterPendingClose(
  preferredActiveTabId: string | null,
  canonicalActiveTabId: string | null,
  groupTabIds: readonly string[],
  pendingCloseTabIds: ReadonlySet<string>,
): string | null {
  if (preferredActiveTabId && !pendingCloseTabIds.has(preferredActiveTabId)) return preferredActiveTabId
  if (canonicalActiveTabId && canonicalActiveTabId !== preferredActiveTabId && !pendingCloseTabIds.has(canonicalActiveTabId)) {
    return canonicalActiveTabId
  }
  return groupTabIds.find((tabId) => !pendingCloseTabIds.has(tabId)) ?? null
}
