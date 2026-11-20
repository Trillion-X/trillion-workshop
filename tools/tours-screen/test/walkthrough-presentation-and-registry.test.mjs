// The package's tests of the walkthrough presentation DATA (show/walkthrough-presentation.ts) and the open presentation
// registry (show/presentation-registry.ts), carried over from tools/tours-screen/show/*.test.ts.held. The two modules
// import the shared ui parts without file extensions, as the web client's bundler reads them, so the test builds them
// the same way (esbuild, in memory, nothing written) and imports the result.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { importSource } from '../../../test-helpers/import-source-for-tests.mjs';
import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';

const here = fileURLToPath(new URL('../', import.meta.url));
const bundled = async entry => {
  const built = await build({
    stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: here, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'trillion-workshop/*'], jsx: 'automatic',
  });
  return importSource(built.outputFiles[0].text, undefined, { from: here });
};

const { fitCutoutToViewport, resolveSpotlightAppearance, resolveTargetingOptions } = await bundled('./show/walkthrough-presentation.ts');
const { DefaultWalkthroughPresentation, createWalkthroughPresentationRegistry, registerWalkthroughPresentations } = await bundled('./show/presentation-registry.ts');
const { default: defaults } = await import('../guided-overlay-defaults.json', { with: { type: 'json' } });

describe('guided-overlay presentation DATA', () => {
  it('uses the package DATA defaults and permits per-walkthrough overrides', () => {
    expect(resolveSpotlightAppearance(undefined).scrimColor).toBe(defaults.spotlight.scrim_color);
    expect(resolveSpotlightAppearance({ spotlight: { scrim_color: 'rgba(0,0,0,.4)', ring_width_px: 2 } }))
      .toMatchObject({ scrimColor: 'rgba(0,0,0,.4)', ringWidthPx: 2 });
    expect(resolveTargetingOptions({ targeting: { retry_timeout_ms: 9000 } }).retryTimeoutMs).toBe(9000);
  });

  it('keeps ring and punch-through geometry inside every viewport edge', () => {
    expect(fitCutoutToViewport(
      { x: -8, y: -4, width: 100, height: 52, rx: 12, ry: 12 },
      { width: 320, height: 200 },
    )).toEqual({ x: 0, y: 0, width: 92, height: 48, rx: 12, ry: 12 });
    expect(fitCutoutToViewport(
      { x: 300, y: 180, width: 40, height: 40, rx: 12, ry: 12 },
      { width: 320, height: 200 },
    )).toEqual({ x: 300, y: 180, width: 20, height: 20, rx: 10, ry: 10 });
  });
});

describe('open walkthrough presentation registry', () => {
  it('keeps absent and unknown refs on the byte-compatible default presenter', () => {
    const registry = createWalkthroughPresentationRegistry();
    expect(registry.resolve(undefined)).toBe(DefaultWalkthroughPresentation);
    expect(registry.resolve('package::future::presentation::unknown')).toBe(DefaultWalkthroughPresentation);
  });

  it('injects arbitrary package-owned presenters without a shared vocabulary change', () => {
    const injected = () => null;
    const registry = registerWalkthroughPresentations(createWalkthroughPresentationRegistry(), {
      'package::example::presentation::one': injected,
    });
    expect(registry.resolve('package::example::presentation::one')).toBe(injected);
    expect(registry.refs()).toEqual(['package::example::presentation::one']);
  });
});
