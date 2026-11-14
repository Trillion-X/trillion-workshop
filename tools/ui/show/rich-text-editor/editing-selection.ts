// Native editable mechanics shared by block editors. The caller owns its text
// model and supplies the serializer, including any marks or atomic mentions.
const composingRoots = new WeakSet<EventTarget>();

export function trackTextComposition(element: HTMLElement): () => void {
  const start = () => composingRoots.add(element);
  const end = () => composingRoots.delete(element);
  element.addEventListener('compositionstart', start);
  element.addEventListener('compositionend', end);
  return () => {
    element.removeEventListener('compositionstart', start);
    element.removeEventListener('compositionend', end);
    composingRoots.delete(element);
  };
}

// WebKit can report the commit key with isComposing=false and keyCode=229.
export function isTextCompositionKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'target'>): boolean {
  return event.isComposing || event.keyCode === 229 || !!(event.target && composingRoots.has(event.target));
}

export type EditableTextSplit = { before: string; after: string };

/** Read the text outside the selected range. Cloned fragments keep mark wrappers
 * and whole mention chips, so splitting never slices an encoded token in half.
 * A selection outside this editable is left to its owning surface. */
export function splitEditableSelection(element: HTMLElement, read: (element: HTMLElement) => string): EditableTextSplit | null {
  const doc = element.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const textIn = (from: Range) => {
    const holder = doc.createElement('div');
    holder.append(from.cloneContents());
    return read(holder);
  };
  const before = doc.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const after = doc.createRange();
  after.selectNodeContents(element);
  after.setStart(range.endContainer, range.endOffset);
  return { before: textIn(before), after: textIn(after) };
}
