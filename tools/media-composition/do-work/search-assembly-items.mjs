// Adapt the one Workshop search answer to the media author's existing scored
// spans. Its caller supplies the assemble-search-hits ruleset's score floor;
// the fused result score is only a ranking and cannot satisfy that floor.
// Evidence stays in the search owner's order: raw scores from different models
// are never sorted or compared to each other. One qualifying semantic witness
// is enough for a moment, and several witnesses never duplicate the clip.
export function searchAssemblyItems(answer, { minimumScore } = {}) {
  if (!Number.isFinite(minimumScore)) throw new TypeError('The assembly ruleset must supply its minimum score.');
  const items = [];
  for (const result of answer?.results ?? []) {
    for (const moment of result.moments ?? []) {
      if (moment.timed !== true || !Number.isFinite(moment.start) || !Number.isFinite(moment.end)
        || moment.start < 0 || moment.end <= moment.start) continue;
      const evidence = (moment.evidence ?? []).find(item => item.match === 'meaning'
        && Number.isFinite(item.score) && item.score >= minimumScore
        && Number.isFinite(item.start ?? moment.start) && (item.start ?? moment.start) >= 0
        && Number.isFinite(item.end ?? moment.end) && (item.end ?? moment.end) > (item.start ?? moment.start)
        && typeof (item.address ?? result.address) === 'string' && (item.address ?? result.address).length > 0);
      if (!evidence) continue;
      items.push({
        address: evidence.address ?? result.address,
        ...(result.identity ? { identity: result.identity } : {}),
        ...(result.file ? { file: result.file } : {}),
        in_point: evidence.start ?? moment.start, out_point: evidence.end ?? moment.end,
        score: evidence.score, evidence: { ...evidence },
        ...(evidence.index_id ? { index_id: evidence.index_id } : {}),
        ...(typeof moment.said === 'string' ? { said: moment.said } : {}),
      });
    }
  }
  return items;
}
