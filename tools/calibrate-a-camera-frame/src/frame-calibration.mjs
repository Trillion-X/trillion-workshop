// src/frame-calibration.mjs
//
// PURPOSE
//   Calibrate a spatial frame once per session, then keep every later measurement in that normalized frame. Four detected corners
//   give a projective map to the unit square; the detector's confidence decides whether the automatic result stands, a guided
//   manual fallback supplies corners when it does not, and each failed automatic attempt is kept so it can be uploaded as training data.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a court, a screen, a detector or a mount. `detect`, `manual` and `report` are functions handed
//      in; the confidence floor is the caller's DATA.
//   2. The answer always says where the frame came from (auto or manual) and the confidence that was seen; a low-confidence
//      result is never presented as good.
//   3. Corners that cannot form a map (collinear, repeated) are refused in words.
//
const refusal = message => Object.assign(new Error(message), { status: 400 });

/** Solves A·x = b by Gaussian elimination with partial pivoting; null when singular. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-12) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** The projective map taking four corners (top-left, top-right, bottom-right, bottom-left, as [x, y]) onto the unit square. */
export function homographyFromCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4 || corners.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
    throw refusal('Four corners, each [x, y], are needed to calibrate.');
  }
  const target = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const A = []; const b = [];
  corners.forEach(([x, y], i) => {
    const [u, v] = target[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  });
  const h = solve(A, b);
  if (!h) throw refusal('Those corners do not form a frame (they are repeated or in a line).');
  return [...h, 1];
}

/** A point in the source image → the normalized frame ([0,1] inside the corners). */
export function toFrame(h, [x, y]) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/**
 * detect() → { corners, confidence } | null; manual() → corners | null (the guided adjustment); report(failure) keeps a failed
 * automatic attempt for upload. → { state: 'calibrated', source, confidence, h } or { state: 'needs_manual', confidence }.
 */
export async function calibrate({ detect, manual, report: observe = () => {}, min_confidence }) {
  if (!Number.isFinite(min_confidence)) throw refusal('A confidence floor is needed.');
  const seen = await detect();
  if (seen?.corners && seen.confidence >= min_confidence) {
    try { return { state: 'calibrated', source: 'auto', confidence: seen.confidence, h: homographyFromCorners(seen.corners) }; }
    catch (error) { await observe({ reason: error.message, attempt: seen }); }
  } else await observe({ reason: seen ? 'low_confidence' : 'nothing_detected', attempt: seen ?? null });
  const corners = manual ? await manual() : null;
  if (!corners) return { state: 'needs_manual', confidence: seen?.confidence ?? 0 };
  return { state: 'calibrated', source: 'manual', confidence: seen?.confidence ?? 0, h: homographyFromCorners(corners) };
}
