// Frame inventory rows without a resolved owner cannot be safely matched to a demo.
// The control-name caller handles those rows as unavailable AX evidence instead.
export function demoFramesForRule(frames, rule) {
  return frames.filter(item => item.owner?.shown
    && rule.demo_url_patterns.some(source => new RegExp(source, 'i').test(`${item.owner.src} ${item.frame.url} ${item.frame.unreachableUrl ?? ''}`)));
}
