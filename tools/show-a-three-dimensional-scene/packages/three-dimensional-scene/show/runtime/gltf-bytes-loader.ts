import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationClip } from 'three';
import type { AddressRef, SceneAssetDescriptor } from '../../read-data/scene-descriptor';
import type { AssetLoaderCapability, SceneEnvironment } from './capability-registry';

function sourceOf(asset: SceneAssetDescriptor): AddressRef {
  const source = asset.input.source as Record<string, unknown> | undefined;
  if (!source || typeof source.address !== 'string' || !source.address.trim()) throw new Error(`asset ${asset.id} requires source.address`);
  if (/^(data|blob|file|javascript):/i.test(source.address)) throw new Error(`asset ${asset.id} has a forbidden source scheme`);
  if (/^https?:/i.test(source.address) && !/^https:/i.test(source.address)) throw new Error(`asset ${asset.id} requires https`);
  if (typeof source.mediaType === 'string' && /(html|javascript|ecmascript)/i.test(source.mediaType)) throw new Error(`asset ${asset.id} has a forbidden media type`);
  return { address: source.address, ...(typeof source.sha256 === 'string' ? { sha256: source.sha256 } : {}), ...(typeof source.mediaType === 'string' ? { mediaType: source.mediaType } : {}) };
}

async function verify(bytes: ArrayBuffer, expected: string | undefined): Promise<void> {
  if (!expected) return;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.toLowerCase()) throw new Error('asset SHA-256 mismatch');
}

export function parseAnimationClipJson(bytes: ArrayBuffer): readonly AnimationClip[] {
  const document = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const clipDocument = document && typeof document === 'object' && 'clip' in document
    ? (document as { clip: unknown }).clip
    : document;
  return [AnimationClip.parse(clipDocument as Parameters<typeof AnimationClip.parse>[0])];
}

async function cached<Value>(env: SceneEnvironment, key: string, load: () => Promise<Value>): Promise<Value> {
  if (!env.resourceCache) return load();
  const existing = env.resourceCache.get(key) as Promise<Value> | undefined;
  if (existing) return existing;
  const loading = load(); env.resourceCache.set(key, loading);
  try { return await loading; }
  catch (error) { env.resourceCache.delete(key); throw error; }
}

const cacheKey = (kind: string, source: AddressRef) => `${kind}:${source.sha256 ?? source.address}:${source.mediaType ?? ''}`;

export function createGltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

export const gltfBytesLoader: AssetLoaderCapability = {
  async load(asset: SceneAssetDescriptor, env: SceneEnvironment, signal: AbortSignal) {
    const source = sourceOf(asset);
    const gltf = await cached(env, cacheKey('gltf', source), async () => {
      const bytes = await env.resolveAddress(source, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await verify(bytes, source.sha256);
      return createGltfLoader().parseAsync(bytes, '');
    });
    let animations: readonly AnimationClip[] = gltf.animations;
    if (asset.animation?.source) {
      const animationSource = asset.animation.source;
      animations = await cached(env, cacheKey('animation', animationSource), async () => {
        const animationBytes = await env.resolveAddress(animationSource, signal);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        await verify(animationBytes, animationSource.sha256);
        return /json/i.test(animationSource.mediaType ?? '')
          ? parseAnimationClipJson(animationBytes)
          : (await createGltfLoader().parseAsync(animationBytes, '')).animations;
      });
    }
    const object = cloneSkeleton(gltf.scene);
    if (asset.objectNamePrefix) object.traverse((candidate) => { if (candidate.name) candidate.name = `${asset.objectNamePrefix}${candidate.name}`; });
    return { object, animations };
  },
};
