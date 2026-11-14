import type { AnimationClip, Object3D } from 'three';
import type { AddressRef, CapabilityRef, SceneAssetDescriptor } from '../../read-data/scene-descriptor';

export interface CapabilityRegistry<T> { get(ref: CapabilityRef): T | null; }
export function createCapabilityRegistry<T>(entries: Readonly<Record<string, T>>): CapabilityRegistry<T> {
  const copy = new Map(Object.entries(entries));
  return { get: (ref) => copy.get(ref.capabilityId) ?? null };
}

export type SceneEnvironment = {
  element: HTMLElement;
  surfaceInput?: unknown;
  reducedMotion: boolean;
  resolveAddress: (ref: AddressRef, signal: AbortSignal) => Promise<ArrayBuffer>;
  resourceCache?: Map<string, Promise<unknown>>;
};
export type SceneDriver = { sample(): number; subscribe(markDirty: () => void): () => void; dispose(): void };
export type DriverCapability = { create(input: Record<string, unknown>, env: SceneEnvironment): SceneDriver };
export type LoadedAsset = { object: Object3D; animations?: readonly AnimationClip[]; dispose?: () => void };
export type AssetLoaderCapability = { load(asset: SceneAssetDescriptor, env: SceneEnvironment, signal: AbortSignal): Promise<LoadedAsset> };
export type InterpolationCapability = { interpolate(from: unknown, to: unknown, t: number): unknown };
export type EasingCapability = { map(t: number): number };
export type ActivationCapability = { bind(input: { element: HTMLElement; object: string; accessibleLabel: string; matches?: (event: Event) => boolean }, activate: () => void): () => void };

export type SceneCapabilityRegistries = {
  drivers: CapabilityRegistry<DriverCapability>;
  loaders: CapabilityRegistry<AssetLoaderCapability>;
  interpolations: CapabilityRegistry<InterpolationCapability>;
  easings: CapabilityRegistry<EasingCapability>;
  activations: CapabilityRegistry<ActivationCapability>;
};
