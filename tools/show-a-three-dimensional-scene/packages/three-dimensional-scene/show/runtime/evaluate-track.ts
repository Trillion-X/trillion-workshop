import type { SceneKeyframe, SceneTrackDescriptor, SceneViewportProfile } from '../../read-data/scene-descriptor';
import type { CapabilityRegistry, EasingCapability, InterpolationCapability } from './capability-registry';

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function evaluateTrack(
  track: SceneTrackDescriptor,
  progress: number,
  interpolations: CapabilityRegistry<InterpolationCapability>,
  easings: CapabilityRegistry<EasingCapability>,
  viewportProfile: SceneViewportProfile = 'desktop',
): unknown {
  const frames = track.keyframes;
  const valueFor = (frame: SceneKeyframe) => viewportProfile === 'desktop'
    ? frame.value
    : frame.responsive?.[viewportProfile] ?? frame.value;
  if (progress <= frames[0].at) return valueFor(frames[0]);
  if (progress >= frames[frames.length - 1].at) return valueFor(frames[frames.length - 1]);
  let low = 0; let high = frames.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle].at <= progress) low = middle; else high = middle;
  }
  const from = frames[low]; const to = frames[high];
  const interpolator = interpolations.get(track.interpolation);
  if (!interpolator) throw new Error(`unknown interpolation ${track.interpolation.capabilityId}`);
  const easingRef = to.easing ?? from.easing;
  const linearT = clamp((progress - from.at) / (to.at - from.at));
  const easing = easingRef ? easings.get(easingRef) : null;
  if (easingRef && !easing) throw new Error(`unknown easing ${easingRef.capabilityId}`);
  return interpolator.interpolate(valueFor(from), valueFor(to), easing ? easing.map(linearT) : linearT);
}
