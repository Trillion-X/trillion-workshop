/** Editors keep their own formatting bar. This opens the shared response thread
 * for its retained selection, without adding another selection toolbar. */
export const SELECTION_COMMENT_REQUEST = 'trillion:selection-comment';

export function requestSelectionResponse(eventName: string, range: Range): boolean {
  return !document.dispatchEvent(new CustomEvent(eventName, {
    detail: range.cloneRange(), cancelable: true,
  }));
}
