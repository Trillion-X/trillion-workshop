import content from './lesson-content.json' with { type: 'json' };

export function frameFor(frameId) {
  const frame = content.example.frames.find(row => row.id === frameId);
  if (!frame) throw new TypeError(`Unknown M054 frame: ${frameId}`);
  return frame;
}
