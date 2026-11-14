import { Color, Quaternion } from 'three';
import { gltfBytesLoader } from './gltf-bytes-loader';
import {
  createCapabilityRegistry,
  type ActivationCapability,
  type DriverCapability,
  type EasingCapability,
  type InterpolationCapability,
  type SceneCapabilityRegistries,
  type SceneDriver,
} from './capability-registry';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const number = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
};
const tuple = (value: unknown, size: number, label: string) => {
  if (!Array.isArray(value) || value.length !== size) throw new Error(`${label} must be a tuple`);
  return value.map((entry) => number(entry, label));
};

function scrollDriver(input: Record<string, unknown>, env: Parameters<DriverCapability['create']>[1]): SceneDriver {
  const element = input.container === 'self' || input.container === undefined ? env.element : env.element.querySelector(String(input.container));
  if (!(element instanceof HTMLElement)) throw new Error('scroll container is unavailable');
  let subscriber: (() => void) | null = null;
  const notify = () => subscriber?.();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(notify);
  observer?.observe(element);
  window.addEventListener('scroll', notify, { passive: true });
  return {
    sample: () => {
      const rect = element.getBoundingClientRect();
      const travel = Math.max(1, rect.height - window.innerHeight);
      return clamp(-rect.top / travel);
    },
    subscribe: (markDirty) => { subscriber = markDirty; return () => { if (subscriber === markDirty) subscriber = null; }; },
    dispose: () => { observer?.disconnect(); window.removeEventListener('scroll', notify); subscriber = null; },
  };
}

function clockDriver(input: Record<string, unknown>, env: Parameters<DriverCapability['create']>[1]): SceneDriver {
  const duration = Math.max(1, number(input.durationMs ?? 1000, 'durationMs'));
  const overridePath = typeof input.overridePath === 'string' ? input.overridePath.split('.').filter(Boolean) : [];
  const override = () => {
    if (!overridePath.length) return null;
    let value: unknown = env.surfaceInput;
    for (const segment of overridePath) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : null;
  };
  const started = performance.now();
  let subscriber: (() => void) | null = null; let frame = 0; let disposed = false;
  const tick = () => { if (disposed || env.reducedMotion || override() !== null || document.hidden) return; subscriber?.(); frame = requestAnimationFrame(tick); };
  return {
    sample: () => override() ?? (env.reducedMotion ? 0 : ((performance.now() - started) % duration) / duration),
    subscribe: (markDirty) => { subscriber = markDirty; if (!frame && !env.reducedMotion && override() === null) frame = requestAnimationFrame(tick); return () => { subscriber = null; if (frame) cancelAnimationFrame(frame); frame = 0; }; },
    dispose: () => { disposed = true; subscriber = null; if (frame) cancelAnimationFrame(frame); },
  };
}

function addressedDriver(input: Record<string, unknown>, env: Parameters<DriverCapability['create']>[1]): SceneDriver {
  const path = typeof input.path === 'string' ? input.path.split('.').filter(Boolean) : [];
  return {
    sample: () => {
      let value: unknown = env.surfaceInput;
      for (const segment of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
      return typeof value === 'number' && Number.isFinite(value) ? value : number(input.fallback ?? 0, 'fallback');
    },
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

const scalar: InterpolationCapability = { interpolate: (from, to, t) => number(from, 'from') + (number(to, 'to') - number(from, 'from')) * t };
const vector = (size: number): InterpolationCapability => ({ interpolate: (from, to, t) => {
  const a = tuple(from, size, 'from'); const b = tuple(to, size, 'to'); return a.map((value, index) => value + (b[index] - value) * t);
} });
const quaternion: InterpolationCapability = { interpolate: (from, to, t) => new Quaternion().fromArray(tuple(from, 4, 'from')).slerp(new Quaternion().fromArray(tuple(to, 4, 'to')), t).normalize().toArray() };
const color: InterpolationCapability = { interpolate: (from, to, t) => new Color(String(from)).lerp(new Color(String(to)), t).getStyle() };
const discrete: InterpolationCapability = { interpolate: (from, to, t) => t === 1 ? to : from };
const linear: EasingCapability = { map: clamp };
const smoothstep: EasingCapability = { map: (value) => { const t = clamp(value); return t * t * (3 - 2 * t); } };

const pointer: ActivationCapability = { bind: ({ element, matches }, activate) => {
  const listener = (event: Event) => { if (event instanceof PointerEvent && event.isPrimary && (!matches || matches(event))) activate(); };
  element.addEventListener('pointerup', listener); return () => element.removeEventListener('pointerup', listener);
} };
const keyboard: ActivationCapability = { bind: ({ element }, activate) => {
  const listener = (event: Event) => { const key = (event as KeyboardEvent).key; if (key === 'Enter' || key === ' ') { event.preventDefault(); activate(); } };
  element.addEventListener('keydown', listener); return () => element.removeEventListener('keydown', listener);
} };

export function createBuiltinSceneCapabilities(): SceneCapabilityRegistries {
  return {
    drivers: createCapabilityRegistry({ 'driver.scroll-element-progress': { create: scrollDriver }, 'driver.animation-clock': { create: clockDriver }, 'driver.addressed-number': { create: addressedDriver } }),
    loaders: createCapabilityRegistry({ 'loader.gltf-bytes': gltfBytesLoader }),
    interpolations: createCapabilityRegistry({ 'interpolate.scalar': scalar, 'interpolate.vec3': vector(3), 'interpolate.quaternion': quaternion, 'interpolate.color': color, 'interpolate.discrete': discrete }),
    easings: createCapabilityRegistry({ 'easing.linear': linear, 'easing.smoothstep': smoothstep }),
    activations: createCapabilityRegistry({ 'activation.pointer': pointer, 'activation.keyboard': keyboard }),
  };
}
