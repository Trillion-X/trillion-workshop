// Validate one run's captures and selected test result; visual inspection remains a separate check.
export const firstPaintCaptures = ['first-open-ready', 'second-open-1.5s', 'second-open-3.0s', 'second-open-6.0s', 'second-open-9.0s'];

export function assertFirstPaintEvidence({ code, log, captures }) {
  if (code !== 0 || !log.includes('** TEST SUCCEEDED **') || !log.split('\n').some(line => /FirstPaintProof/.test(line) && /testSecondOpenShowsReadyWorkspace/.test(line) && /\bpassed\b/.test(line))) {
    throw new Error('The selected first-paint test did not pass.');
  }
  let previous = -1;
  for (const name of firstPaintCaptures) {
    const { png, state } = captures[name] ?? {};
    if (!Buffer.isBuffer(png) || png.length < 45 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.toString('ascii', 12, 16) !== 'IHDR' || !png.readUInt32BE(16) || !png.readUInt32BE(20)
      || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') throw new Error(`The ${name} screenshot is missing or invalid.`);
    const fields = Object.fromEntries(String(state ?? '').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    if (!fields.paint || !fields.requested || !['true', 'false'].includes(fields.foreground)) throw new Error(`The ${name} capture has incomplete observed state.`);
    if (name === 'first-open-ready' || name === 'second-open-9.0s') {
      if (fields.foreground !== 'true' || fields.requested !== '/') throw new Error(`The ${name} capture is not the foreground Home workspace.`);
      if (fields.paint !== 'Ready: /') throw new Error(`The ${name} capture has no ready workspace paint.`);
    }
    if (name !== 'first-open-ready') {
      const elapsed = Number(fields.sample_at_seconds);
      if (!fields.sample_at_seconds || !Number.isFinite(elapsed) || elapsed < previous || elapsed < Number(name.slice('second-open-'.length, -1))) throw new Error(`The ${name} capture has invalid elapsed time.`);
      previous = elapsed;
    }
  }
}
