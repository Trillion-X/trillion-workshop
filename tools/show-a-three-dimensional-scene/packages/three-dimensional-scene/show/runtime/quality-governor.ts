import type { SceneAssetDescriptor, SceneQualityPolicy } from '../../read-data/scene-descriptor';

export type SceneQualityTier = 'high' | 'medium' | 'low' | 'fallback';
export function selectQualityTier(input: { mobile: boolean; reducedMotion: boolean; webgl: boolean }): SceneQualityTier {
  if (!input.webgl) return 'fallback';
  if (input.reducedMotion) return 'low';
  return input.mobile ? 'medium' : 'high';
}
export function clampedDevicePixelRatio(policy: SceneQualityPolicy, tier: SceneQualityTier, devicePixelRatio = 1): number {
  const tierMaximum = tier === 'high' ? policy.maxDevicePixelRatio : tier === 'medium' ? Math.min(1.5, policy.maxDevicePixelRatio) : 1;
  return Math.max(1, Math.min(devicePixelRatio || 1, tierMaximum));
}

export function selectAssetForQualityTier(asset: SceneAssetDescriptor, tier: SceneQualityTier): SceneAssetDescriptor {
  const candidates = tier === 'low' ? ['low', 'medium'] as const : tier === 'fallback' ? ['fallback', 'low', 'medium'] as const : [tier] as const;
  const variant = candidates.map((candidate) => asset.qualityVariants?.[candidate]).find(Boolean);
  return variant ? { ...asset, input: variant.input } : asset;
}
