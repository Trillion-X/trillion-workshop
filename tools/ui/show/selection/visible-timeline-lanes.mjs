// Presentation rows for a timeline. Timing, identity and the saved track never
// change; synthetic row ids retain their saved owner id in savedLaneId.
//
// A lane chooses how its elements occupy rows as DATA (`elementRows`):
//   'own'    (default) every element gets its own editable row;
//   'shared' elements share a row until they overlap, so a lane of many short
//            timed items (captions, words) stays one readable row.
function presentationRows(lane) {
  const ordered = [...lane.clips].sort((a, b) => a.laneStart - b.laneStart || a.clipId.localeCompare(b.clipId));
  if (lane.elementRows !== 'shared') return ordered.map(clip => [clip]);
  const rows = [], ends = [];
  for (const clip of ordered) {
    let index = ends.findIndex(end => end <= clip.laneStart);
    if (index < 0) { index = rows.length; rows.push([]); }
    rows[index].push(clip);
    ends[index] = clip.laneEnd;
  }
  return rows;
}

export function visibleTimelineLanes(lanes) {
  return lanes.flatMap(lane => {
    if (lane.clips.length < 2) return [lane];
    const rows = presentationRows(lane);
    if (rows.length < 2) return [lane];
    return rows.map((clips, index) => ({
      ...lane,
      laneId: index ? `${lane.laneId}:row:${clips[0].clipId}` : lane.laneId,
      savedLaneId: lane.laneId,
      clips,
    }));
  });
}
