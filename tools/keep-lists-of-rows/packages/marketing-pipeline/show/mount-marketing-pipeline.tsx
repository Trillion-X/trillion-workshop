// package-set://bitfield-studio/packages/marketing-pipeline/show/mount-marketing-pipeline.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The mount boundary for the Coordination Workbench. Reads a
// CoordinationSurfaceModel (from explicit input or the shared reader) and
// renders the generic MarketingPipelineSurface into a host element. The surface
// component itself lives in `./MarketingPipelineSurface`; this file owns only
// the data-read → render wiring and re-exports the surface so callers have one
// import site.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The data boundary is `readCoordinationRecords` — the mount never invents
//    records or copy.
// 2. `mountMarketingPipeline({ input })` (no el) returns the resolved model
//    and logs the record count — used to verify the model boundary in tests and
//    by the package host.
// 3. The host mount contract passes `el` (same as every mountReactMaterial
//    package). Reading any other key silently early-returns without rendering —
//    that exact bug shipped a blank surface (2026-07-24).
//
// =============================================================================

import React from 'react';
import { mountReactMaterial } from '@/packages/ui';
import {
  readCoordinationRecords,
  type CoordinationInput,
  type CoordinationSurfaceModel,
} from '../read-data/read-coordination-records';
import { MarketingPipelineSurface } from './MarketingPipelineSurface';

export { MarketingPipelineSurface } from './MarketingPipelineSurface';
export type { MarketingPipelineSurfaceProps } from './MarketingPipelineSurface';

export interface MarketingPipelineMountOptions {
  el?: HTMLElement | null;
  props?: Record<string, unknown>;
  input?: CoordinationInput;
  model?: CoordinationSurfaceModel;
}

export function mountMarketingPipeline(options: MarketingPipelineMountOptions = {}) {
  const model = options.model ?? readCoordinationRecords(options.input ?? {});
  console.info(`[marketing-pipeline] mounted surface model records=${model.records.length}`);
  if (!options.el) return { model };
  const unmount = mountReactMaterial(
    options.el,
    React.createElement(MarketingPipelineSurface, { model }),
    options.props ?? {},
    'Marketing Pipeline',
  );
  return { model, unmount };
}

export default mountMarketingPipeline;
