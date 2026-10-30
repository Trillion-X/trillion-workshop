// Lower orders paint first. Unordered legacy EDLs retain images-before-video.
export function visualOverlayOrder(edl) {
  return [
    ...(Array.isArray(edl.image_overlays) ? edl.image_overlays : []).map((item, index) => ({kind:'image', item, index})),
    ...(Array.isArray(edl.video_overlays) ? edl.video_overlays : []).map((item, index) => ({kind:'video', item, index})),
  ].sort((a,b) => (Number.isFinite(a.item?.layer_order) ? a.item.layer_order : 0) - (Number.isFinite(b.item?.layer_order) ? b.item.layer_order : 0));
}

export function visualOverlayBatches(edl) {
  const batches=[];
  for (const row of visualOverlayOrder(edl)) {
    if (batches.at(-1)?.kind !== row.kind) batches.push({kind:row.kind, items:[]});
    batches.at(-1).items.push(row.item);
  }
  return batches;
}
