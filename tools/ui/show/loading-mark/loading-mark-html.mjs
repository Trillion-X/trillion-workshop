// The server-rendered form of the same needle and stitched thread as LoadingMark.tsx.
// The drawing stays in stitch.ts and its motion stays in screen-look/loading-mark.css.
import { NEEDLE_BODY, NEEDLE_EYE, STITCH_PATH } from './stitch.ts';

export function loadingMarkHtml(size = 'md') {
  const chosen = ['sm', 'md', 'lg'].includes(size) ? size : 'md';
  return `<span class="loading-mark" data-loading-mark="${chosen}" aria-hidden="true"><svg class="loading-mark-art" viewBox="0 0 64 24" fill="none" aria-hidden="true" focusable="false" preserveAspectRatio="none"><path class="loading-mark-guide" d="${STITCH_PATH}" pathLength="100"/><path class="loading-mark-thread" d="${STITCH_PATH}" pathLength="100"/><g class="loading-mark-needle" style="offset-path:path('${STITCH_PATH}')"><path class="loading-mark-needle-body" d="${NEEDLE_BODY}"/><ellipse class="loading-mark-needle-eye" cx="${NEEDLE_EYE.cx}" cy="${NEEDLE_EYE.cy}" rx="${NEEDLE_EYE.rx}" ry="${NEEDLE_EYE.ry}"/></g></svg></span>`;
}
