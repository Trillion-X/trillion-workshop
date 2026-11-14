import {
  ACESFilmicToneMapping,
  AnimationMixer,
  Color,
  FogExp2,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  PCFSoftShadowMap,
  LoopOnce,
  LoopRepeat,
  type Object3D,
} from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { AddressRef, ThreeDimensionalSceneDescriptor } from '../../read-data/scene-descriptor';
import { validateSceneDescriptor } from '../../read-data/validate-scene-descriptor';
import { applyTrackValue } from './apply-track-value';
import { createBuiltinSceneCapabilities } from './builtin-capabilities';
import type { LoadedAsset, SceneCapabilityRegistries, SceneDriver } from './capability-registry';
import { createObjectIndex } from './create-object-index';
import { disposeThreeObject } from './dispose-three-object';
import { evaluateTrack } from './evaluate-track';
import { clampedDevicePixelRatio, selectAssetForQualityTier, selectQualityTier } from './quality-governor';
import { createProceduralSurfaceMaterials } from './procedural-surface-materials';

export type SceneRuntimeState = 'loading' | 'ready' | 'degraded' | 'disposed';
export type SceneRuntime = { markDirty(): void; resetMetrics(): void; retry(): void; dispose(): void; state(): SceneRuntimeState; diagnostics(): Readonly<Record<string, string>> };
export type CreateSceneRuntimeOptions = {
  element: HTMLElement;
  driverElement?: HTMLElement;
  descriptor: ThreeDimensionalSceneDescriptor;
  resolveAddress: (ref: AddressRef, signal: AbortSignal) => Promise<ArrayBuffer>;
  surfaceInput?: unknown;
  capabilities?: SceneCapabilityRegistries;
  rendererFactory?: (options: ConstructorParameters<typeof WebGLRenderer>[0]) => WebGLRenderer;
  onState?: (state: SceneRuntimeState) => void;
  onOutput?: (output: { name: string; value: unknown; revision?: string; sequence?: number }) => void;
};

async function settleWithConcurrency<Value>(
  tasks: readonly (() => Promise<Value>)[],
  maximum: number,
  onSettled?: (result: PromiseSettledResult<Value>, index: number) => void,
): Promise<PromiseSettledResult<Value>[]> {
  const results: PromiseSettledResult<Value>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await tasks[index]() }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
      onSettled?.(results[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, tasks.length) }, worker));
  return results;
}

function appendBoundedSample(samples: number[], value: number, maximum = 256) {
  samples.push(value);
  if (samples.length > maximum) samples.splice(0, samples.length - maximum);
}

function percentile(samples: readonly number[], quantile: number) {
  if (!samples.length) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))];
}

export function createSceneRuntime(options: CreateSceneRuntimeOptions): SceneRuntime {
  const issues = validateSceneDescriptor(options.descriptor);
  if (issues.length) throw new Error(`invalid scene descriptor: ${issues[0].path} ${issues[0].code}`);
  const descriptor = options.descriptor; const capabilities = options.capabilities ?? createBuiltinSceneCapabilities();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobileViewport = matchMedia('(max-width: 767px)').matches;
  const tabletViewport = !mobileViewport && matchMedia('(max-width: 1023px)').matches;
  const viewportProfile = mobileViewport ? 'mobile' : tabletViewport ? 'tablet' : 'desktop';
  const tier = selectQualityTier({ mobile: mobileViewport, reducedMotion, webgl: true });
  const renderer = (options.rendererFactory ?? ((configuration) => new WebGLRenderer(configuration)))({ antialias: tier !== 'low', alpha: descriptor.background.alpha < 1, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = descriptor.environment?.toneMapping === 'none' ? 0 : ACESFilmicToneMapping;
  renderer.toneMappingExposure = descriptor.environment?.exposure ?? 1;
  const shadowsEnabled = descriptor.environment?.shadows === true && tier !== 'low';
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = shadowsEnabled;
    renderer.shadowMap.type = PCFSoftShadowMap;
  }
  renderer.setPixelRatio(clampedDevicePixelRatio(descriptor.quality, tier, devicePixelRatio));
  const gl = renderer.getContext?.();
  const rendererInfo = gl?.getExtension?.('WEBGL_debug_renderer_info');
  const webglVendor = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL) : gl?.getParameter?.(gl.VENDOR);
  const webglRenderer = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : gl?.getParameter?.(gl.RENDERER);
  options.element.appendChild(renderer.domElement); renderer.domElement.setAttribute('aria-hidden', 'true');
  const scene = new Scene(); scene.name = 'runtime-scene'; scene.background = descriptor.background.alpha === 0 ? null : new Color(descriptor.background.color);
  const surfaceMaterials = createProceduralSurfaceMaterials(descriptor.surfaceMaterials, tier);
  if (descriptor.environment?.fog) scene.fog = new FogExp2(descriptor.environment.fog.color, descriptor.environment.fog.density);
  const responsiveFov = mobileViewport ? descriptor.camera.responsiveFov?.mobile : tabletViewport ? descriptor.camera.responsiveFov?.tablet : undefined;
  const camera = new PerspectiveCamera(responsiveFov ?? descriptor.camera.fov, 1, descriptor.camera.near, descriptor.camera.far);
  camera.name = descriptor.camera.objectId; camera.position.fromArray(descriptor.camera.position);
  if (descriptor.camera.quaternion) camera.quaternion.fromArray(descriptor.camera.quaternion);
  else if (descriptor.camera.lookAt) camera.lookAt(new Vector3().fromArray(descriptor.camera.lookAt));
  scene.add(camera);
  const controller = new AbortController(); const diagnostics: Record<string, string> = {};
  const roots: Object3D[] = [camera]; const drivers = new Map<string, SceneDriver>(); const subscriptions: Array<() => void> = [];
  const animationMixers: AnimationMixer[] = []; let animated = false; let lastAnimationTime = performance.now(); let lastRenderedAt = -Infinity;
  const renderDurationsMs: number[] = []; const renderedFrameGapsMs: number[] = [];
  const resetMetrics = () => { renderDurationsMs.length = 0; renderedFrameGapsMs.length = 0; lastRenderedAt = -Infinity; };
  let latestDriverSamples = new Map<string, number>();
  const maximumAnimationFps = mobileViewport ? descriptor.quality.maxAnimationFpsMobile ?? 30 : descriptor.quality.maxAnimationFpsDesktop ?? 60;
  const minimumAnimationFrameInterval = 1000 / maximumAnimationFps;
  const interactionSubscriptions: Array<() => void> = []; const raycaster = new Raycaster(); const pointer = new Vector2(); let outputSequence = 0;
  const boundInteractionActivations = new Set<string>();
  const escapeSelectorValue = (value: string) => globalThis.CSS?.escape?.(value) ?? value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  let index = createObjectIndex([scene]); let frame = 0; let runtimeState: SceneRuntimeState = 'loading'; let disposed = false;
  let viewportVisible = typeof IntersectionObserver === 'undefined';
  const setState = (state: SceneRuntimeState) => { runtimeState = state; options.onState?.(state); };
  const resize = () => { const width = options.element.clientWidth; const height = options.element.clientHeight; if (!width || !height) return false; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); return true; };
  const render = (timestamp = performance.now()) => {
    frame = 0; if (disposed || document.hidden || !viewportVisible || !resize()) return;
    if (animated && timestamp - lastRenderedAt < minimumAnimationFrameInterval) { frame = requestAnimationFrame(render); return; }
    const animationDelta = Math.min(Math.max((timestamp - lastAnimationTime) / 1000, 0), 0.05);
    lastAnimationTime = timestamp;
    if (!reducedMotion) animationMixers.forEach((mixer) => mixer.update(animationDelta));
    const samples = new Map<string, number>();
    for (const [id, driver] of drivers) {
      try { samples.set(id, driver.sample()); delete diagnostics[`driver:${id}`]; }
      catch (error) { diagnostics[`driver:${id}`] = String(error); }
    }
    for (const track of descriptor.tracks) {
      try {
        const object = index.objects.get(track.target.object); if (!object) throw new Error(`object unavailable: ${track.target.object}`);
        const sampled = samples.get(track.driverId); if (sampled === undefined) throw new Error(`driver unavailable: ${track.driverId}`);
        applyTrackValue(object, track.target.propertyPath, evaluateTrack(track, sampled, capabilities.interpolations, capabilities.easings, viewportProfile));
        delete diagnostics[`track:${track.id}`];
      } catch (error) { diagnostics[`track:${track.id}`] = String(error); }
    }
    latestDriverSamples = samples;
    // Camera projection fields can be descriptor tracks too. Resize updates the
    // prior frame's projection, so refresh after track application as well.
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const renderStartedAt = performance.now(); renderer.render(scene, camera);
    appendBoundedSample(renderDurationsMs, performance.now() - renderStartedAt);
    if (Number.isFinite(lastRenderedAt)) appendBoundedSample(renderedFrameGapsMs, timestamp - lastRenderedAt);
    lastRenderedAt = timestamp;
    if (animated && !reducedMotion && !disposed && !document.hidden) frame = requestAnimationFrame(render);
  };
  const markDirty = () => { if (!disposed && !frame && !document.hidden && viewportVisible) frame = requestAnimationFrame(render); };
  for (const driverDescriptor of descriptor.drivers) {
    const capability = capabilities.drivers.get(driverDescriptor.capability);
    if (!capability) { diagnostics[`driver:${driverDescriptor.id}`] = `unknown capability ${driverDescriptor.capability.capabilityId}`; continue; }
    try { const driver = capability.create(driverDescriptor.input, { element: options.driverElement ?? options.element, surfaceInput: options.surfaceInput, reducedMotion, resolveAddress: options.resolveAddress }); drivers.set(driverDescriptor.id, driver); subscriptions.push(driver.subscribe(markDirty)); }
    catch (error) { diagnostics[`driver:${driverDescriptor.id}`] = String(error); }
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(markDirty); observer?.observe(options.element);
  const visibilityObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    const nextVisible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
    if (nextVisible === viewportVisible) return;
    viewportVisible = nextVisible;
    if (!viewportVisible && frame) { cancelAnimationFrame(frame); frame = 0; }
    else if (viewportVisible) { lastAnimationTime = performance.now(); markDirty(); }
  }, { rootMargin: '160px 0px' });
  visibilityObserver?.observe(options.element);
  const onVisibility = () => { if (!document.hidden) markDirty(); };
  const onContextLost = (event: Event) => { event.preventDefault(); if (frame) cancelAnimationFrame(frame); frame = 0; setState('degraded'); };
  const onContextRestored = () => {
    setState('loading'); resetMetrics();
    finalizeBlockingState(); markDirty();
  };
  document.addEventListener('visibilitychange', onVisibility);
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
  const resourceCache = new Map<string, Promise<unknown>>();
  const environment = { element: options.driverElement ?? options.element, surfaceInput: options.surfaceInput, reducedMotion, resolveAddress: options.resolveAddress, resourceCache };
  const loadedAssetCache = new Map<string, Promise<LoadedAsset>>();
  const runtimeAssets = descriptor.assets.map((asset) => selectAssetForQualityTier(asset, tier));
  const assetTasks = runtimeAssets.map((asset) => async (): Promise<LoadedAsset> => {
    const loader = capabilities.loaders.get(asset.loader); if (!loader) throw new Error(`unknown loader ${asset.loader.capabilityId}`);
    const cacheKey = JSON.stringify({ loader: asset.loader, input: asset.input, animation: asset.animation });
    const cached = loadedAssetCache.get(cacheKey);
    if (cached) {
      const loaded = await cached;
      return { object: cloneSkeleton(loaded.object), animations: loaded.animations };
    }
    const loading = loader.load(asset, environment, controller.signal);
    loadedAssetCache.set(cacheKey, loading);
    try { return await loading; }
    catch (error) { loadedAssetCache.delete(cacheKey); throw error; }
  });
  const pendingAssets = new Map<number, LoadedAsset>();
  const loadedAssetObjects = new Map<string, Object3D>();
  const settledAssetIds = new Set<string>();
  const blockingAssetIds = new Set(runtimeAssets.filter((asset) => asset.delivery?.blocking !== false).map((asset) => asset.id));
  const failedBlockingAssetIds = new Set<string>();
  const finalizeBlockingState = () => {
    if ([...blockingAssetIds].some((id) => !settledAssetIds.has(id))) return;
    if (runtimeState === 'loading') setState(failedBlockingAssetIds.size ? 'degraded' : 'ready');
  };
  const bindAvailableInteractions = () => {
    for (const interaction of descriptor.interactions) {
      const target = index.objects.get(interaction.object);
      if (!target) continue;
      delete diagnostics[`interaction:${interaction.id}`];
      const activate = () => options.onOutput?.({ ...interaction.output, revision: descriptor.revision, sequence: ++outputSequence });
      for (const activationRef of interaction.activation) {
        const bindingKey = `${interaction.id}\u0000${activationRef.capabilityId}`;
        if (boundInteractionActivations.has(bindingKey)) continue;
        const capability = capabilities.activations.get(activationRef);
        if (!capability) { diagnostics[`interaction:${interaction.id}:${activationRef.capabilityId}`] = 'unknown activation capability'; continue; }
        const stationId = interaction.output.value && typeof interaction.output.value === 'object'
          ? (interaction.output.value as Record<string, unknown>).stationId
          : undefined;
        const semanticControl = typeof stationId === 'string'
          ? (options.driverElement ?? options.element).querySelector<HTMLElement>(`[data-station-id="${escapeSelectorValue(stationId)}"]`)
          : (options.driverElement ?? options.element).querySelector<HTMLElement>(`[data-scene-interaction-id="${escapeSelectorValue(interaction.id)}"]`);
        const element = activationRef.capabilityId === 'activation.keyboard' ? semanticControl : renderer.domElement;
        if (!element) { diagnostics[`interaction:${interaction.id}:${activationRef.capabilityId}`] = 'semantic control unavailable'; continue; }
        const matches = activationRef.capabilityId === 'activation.pointer'
          ? (event: Event) => {
              const pointerEvent = event as PointerEvent; const rect = renderer.domElement.getBoundingClientRect();
              if (!rect.width || !rect.height) return false;
              pointer.set(((pointerEvent.clientX - rect.left) / rect.width) * 2 - 1, -((pointerEvent.clientY - rect.top) / rect.height) * 2 + 1);
              raycaster.setFromCamera(pointer, camera); return raycaster.intersectObject(target, true).length > 0;
            }
          : undefined;
        interactionSubscriptions.push(capability.bind({ element, object: interaction.object, accessibleLabel: interaction.accessibleLabel, matches }, activate));
        boundInteractionActivations.add(bindingKey);
        delete diagnostics[`interaction:${interaction.id}:${activationRef.capabilityId}`];
      }
    }
  };
  const attachLoadedAsset = (assetIndex: number, loaded: LoadedAsset) => {
      const asset = runtimeAssets[assetIndex];
      const parent = asset.attachTo ? index.objects.get(asset.attachTo) : scene;
      if (!parent) return false;
      loaded.object.name ||= asset.id;
      if (asset.transform?.position) loaded.object.position.fromArray(asset.transform.position);
      if (asset.transform?.rotation) loaded.object.rotation.set(...asset.transform.rotation);
      if (asset.transform?.scale) loaded.object.scale.fromArray(asset.transform.scale);
      surfaceMaterials.apply(loaded.object);
      loaded.object.updateMatrixWorld(true);
      loaded.object.traverse((object) => {
        if (!('isMesh' in object) || !(object as { isMesh?: boolean }).isMesh) return;
        const mesh = object as Object3D & { castShadow: boolean; receiveShadow: boolean };
        mesh.castShadow = shadowsEnabled;
        mesh.receiveShadow = shadowsEnabled;
      });
      parent.add(loaded.object); roots.push(loaded.object);
      loadedAssetObjects.set(asset.id, loaded.object);
      index = createObjectIndex([scene]);
      // Preserve authored child-node names while making the descriptor asset id
      // an authoritative address for tracks and interactions.
      for (const [assetId, object] of loadedAssetObjects) {
        index.objects.set(assetId, object);
        index.duplicates.delete(assetId);
      }
      bindAvailableInteractions();
      if (asset.animation && loaded.animations?.length) {
        const clip = asset.animation.clipName
          ? loaded.animations.find((candidate) => candidate.name === asset.animation?.clipName)
          : loaded.animations[asset.animation.clipIndex ?? 0];
        if (!clip) diagnostics[`asset:${asset.id}:animation`] = `animation clip unavailable: ${asset.animation.clipName ?? asset.animation.clipIndex ?? 0}`;
        else {
          const mixer = new AnimationMixer(loaded.object); const action = mixer.clipAction(clip);
          action.setLoop(asset.animation.loop === false ? LoopOnce : LoopRepeat, asset.animation.loop === false ? 1 : Infinity);
          action.clampWhenFinished = asset.animation.loop === false;
          action.timeScale = asset.animation.timeScale ?? 1;
          action.time = Math.min(asset.animation.startOffset ?? 0, Math.max(clip.duration, 0));
          if (asset.animation.autoplay !== false) {
            action.play();
            animated = true;
            // Reduced motion stops continuous playback, but it must still
            // evaluate the descriptor-owned offset once. Otherwise a rigged
            // character remains in its unevaluated bind/T-pose.
            if (reducedMotion) mixer.update(0);
          }
          animationMixers.push(mixer);
        }
      }
      delete diagnostics[`asset:${asset.id}`];
      return true;
  };
  const flushPendingAssets = () => {
    let attached = true;
    while (attached) {
      attached = false;
      for (const [assetIndex, loaded] of [...pendingAssets].sort(([left], [right]) => left - right)) {
        if (!attachLoadedAsset(assetIndex, loaded)) continue;
        pendingAssets.delete(assetIndex); attached = true;
      }
    }
  };
  void settleWithConcurrency(assetTasks, 4, (result, assetIndex) => {
    const asset = runtimeAssets[assetIndex];
    settledAssetIds.add(asset.id);
    if (result.status === 'rejected') {
      diagnostics[`asset:${asset.id}`] = String(result.reason);
      if (blockingAssetIds.has(asset.id)) failedBlockingAssetIds.add(asset.id);
    }
    else { pendingAssets.set(assetIndex, result.value); flushPendingAssets(); }
    finalizeBlockingState();
    markDirty();
  }).then(() => {
    flushPendingAssets();
    for (const [assetIndex, loaded] of pendingAssets) {
      const asset = runtimeAssets[assetIndex];
      diagnostics[`asset:${asset.id}`] = `attach target unavailable ${asset.attachTo}`;
      loaded.dispose?.();
    }
    pendingAssets.clear();
    bindAvailableInteractions();
    for (const interaction of descriptor.interactions) if (!index.objects.has(interaction.object)) diagnostics[`interaction:${interaction.id}`] = `object unavailable: ${interaction.object}`;
    // Loading/attachment spikes are reported by the delivery probe. Runtime
    // frame percentiles begin at the fully composed scene so they describe
    // steady interaction rather than mixing two distinct failure surfaces.
    resetMetrics();
    finalizeBlockingState(); markDirty();
  });
  markDirty();
  return {
    markDirty,
    resetMetrics,
    retry: () => { if (!disposed) { setState('degraded'); markDirty(); } },
    state: () => runtimeState,
    diagnostics: () => ({
      ...diagnostics,
      'runtime:camera-position': camera.position.toArray().join(','),
      'runtime:camera-quaternion': camera.quaternion.toArray().join(','),
    'runtime:camera-fov': String(camera.fov),
    'runtime:quality-tier': tier,
    'runtime:quality-variant-asset-ids': runtimeAssets.filter((asset, assetIndex) => asset.input !== descriptor.assets[assetIndex].input).map((asset) => asset.id).join(','),
    'runtime:webgl-vendor': String(webglVendor ?? 'unavailable'),
    'runtime:webgl-renderer': String(webglRenderer ?? 'unavailable'),
      'runtime:indexed-objects': String(index.objects.size),
      'runtime:duplicate-object-names': String(index.duplicates.size),
    'runtime:asset-progress': `${settledAssetIds.size}/${runtimeAssets.length}`,
      'runtime:blocking-asset-progress': `${[...blockingAssetIds].filter((id) => settledAssetIds.has(id)).length}/${blockingAssetIds.size}`,
    'runtime:pending-asset-ids': runtimeAssets.filter((asset) => !settledAssetIds.has(asset.id)).map((asset) => asset.id).join(','),
      'runtime:viewport-visible': String(viewportVisible),
      'runtime:max-animation-fps': String(maximumAnimationFps),
      'runtime:driver-samples': JSON.stringify(Object.fromEntries(latestDriverSamples)),
      'runtime:render-sample-count': String(renderDurationsMs.length),
      'runtime:render-ms-p50': percentile(renderDurationsMs, 0.5).toFixed(3),
      'runtime:render-ms-p95': percentile(renderDurationsMs, 0.95).toFixed(3),
      'runtime:render-ms-p99': percentile(renderDurationsMs, 0.99).toFixed(3),
      'runtime:render-ms-worst': Math.max(0, ...renderDurationsMs).toFixed(3),
      'runtime:render-gap-ms-p50': percentile(renderedFrameGapsMs, 0.5).toFixed(3),
      'runtime:render-gap-ms-p95': percentile(renderedFrameGapsMs, 0.95).toFixed(3),
      'runtime:render-gap-ms-p99': percentile(renderedFrameGapsMs, 0.99).toFixed(3),
      'runtime:render-gap-ms-worst': Math.max(0, ...renderedFrameGapsMs).toFixed(3),
      'runtime:missing-track-targets': [...new Set(descriptor.tracks.map((track) => track.target.object).filter((name) => !index.objects.has(name)))].join(','),
      'runtime:duplicate-object-sample': [...index.duplicates].slice(0, 20).join(','),
    }),
    dispose: () => {
      if (disposed) return; disposed = true; setState('disposed'); controller.abort(); if (frame) cancelAnimationFrame(frame);
      subscriptions.splice(0).forEach((unsubscribe) => unsubscribe()); interactionSubscriptions.splice(0).forEach((unsubscribe) => unsubscribe()); drivers.forEach((driver) => driver.dispose()); drivers.clear(); observer?.disconnect(); visibilityObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility); renderer.domElement.removeEventListener('webglcontextlost', onContextLost); renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      animationMixers.splice(0).forEach((mixer) => { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); });
      resourceCache.clear(); loadedAssetCache.clear(); pendingAssets.clear(); loadedAssetObjects.clear(); boundInteractionActivations.clear();
      roots.slice(1).forEach(disposeThreeObject); surfaceMaterials.dispose(); renderer.dispose(); renderer.domElement.remove();
    },
  };
}
