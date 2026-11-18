//
// The one message a framed live page sends its framing page once its screens show real content, so the frame can
// swap its picture for the live page without ever showing a blank or half-drawn window. It carries no data.

export const LIVE_FRAME_READY = 'live-now-frame-ready';

/** Tell the page framing this one (if any) that this page now shows its real content. */
export function tellFramingPageReady(win = globalThis.window) {
  if (!win || win.parent === win) return;
  win.parent.postMessage({ type: LIVE_FRAME_READY }, '*');
}
