import * as React from 'react';
import type { AddressRef } from '../read-data/scene-descriptor';
import { readSceneDescriptor } from '../read-data/read-scene-descriptor';
import { SemanticSceneStory } from './semantic-scene-story';
import { createSceneRuntime, type SceneRuntime, type SceneRuntimeState } from './runtime/create-scene-runtime';

export type ThreeDimensionalSceneSurfaceProps = {
  descriptorSource: unknown;
  surfaceInput?: unknown;
  resolveAddress: (ref: AddressRef, signal: AbortSignal) => Promise<ArrayBuffer>;
  onOutput?: (output: { name: string; value: unknown; revision?: string; sequence?: number }) => void;
};

function posterAddress(source: unknown): string | null {
  const input = source && typeof source === 'object' ? source as Record<string, unknown> : null;
  const nested = input?.source && typeof input.source === 'object' ? input.source as Record<string, unknown> : null;
  return typeof nested?.address === 'string' ? nested.address : null;
}

export function ThreeDimensionalSceneSurface(props: ThreeDimensionalSceneSurfaceProps) {
  const read = React.useMemo(() => readSceneDescriptor({ source: props.descriptorSource }), [props.descriptorSource]);
  const sectionRef = React.useRef<HTMLElement>(null); const hostRef = React.useRef<HTMLDivElement>(null); const runtimeRef = React.useRef<SceneRuntime | null>(null);
  const [state, setState] = React.useState<SceneRuntimeState | 'invalid' | 'unavailable'>('loading');
  const [sequence, setSequence] = React.useState(0);
  React.useEffect(() => {
    if (!read.ok || !hostRef.current) return;
    if (typeof WebGLRenderingContext === 'undefined') { setState('unavailable'); return; }
    try {
      runtimeRef.current = createSceneRuntime({ element: hostRef.current, driverElement: sectionRef.current ?? undefined, descriptor: read.descriptor, resolveAddress: props.resolveAddress, surfaceInput: props.surfaceInput, onState: setState, onOutput: props.onOutput });
    } catch { setState('unavailable'); }
    return () => { runtimeRef.current?.dispose(); runtimeRef.current = null; };
  }, [read, props.resolveAddress, props.surfaceInput]);
  if (!read.ok) return <section data-three-dimensional-scene><div role="img" aria-label="3D scene unavailable" /><article data-semantic-story><h2>Scene unavailable</h2><p>{read.issues[0]?.message}</p></article><div role="status">Invalid scene descriptor</div></section>;
  const descriptor = read.descriptor; const poster = descriptor.fallbackPoster ? posterAddress(descriptor.fallbackPoster.input) : null;
  const activateStation = (stationId: string) => {
    const next = sequence + 1; setSequence(next);
    props.onOutput?.({ name: 'station.select', value: { stationId }, revision: descriptor.revision, sequence: next });
    document.getElementById(stationId)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return (
    <section ref={sectionRef} data-three-dimensional-scene data-scene-state={state} onKeyDown={(event) => { if (event.key === 'Escape') (event.currentTarget as HTMLElement).focus(); }} tabIndex={-1}>
      <div role="img" aria-label={descriptor.canvasLabel}>
        <div ref={hostRef} data-scene-canvas-host />
        {state !== 'ready' && poster ? <img src={poster} alt={descriptor.fallbackPoster?.alt ?? descriptor.canvasLabel} /> : null}
      </div>
      <nav aria-label="Scene chapters">
        {descriptor.semanticSections.map((section) => <button key={section.id} type="button" onClick={() => activateStation(section.stationId ?? section.id)}>{section.heading}</button>)}
      </nav>
      <SemanticSceneStory sections={descriptor.semanticSections} />
      <div role="status">{state === 'ready' ? 'Interactive scene ready' : state === 'loading' ? 'Loading interactive scene' : 'Interactive scene unavailable; the complete story remains below.'}</div>
      {state === 'degraded' ? <button type="button" onClick={() => runtimeRef.current?.retry()}>Retry 3D scene</button> : null}
    </section>
  );
}
