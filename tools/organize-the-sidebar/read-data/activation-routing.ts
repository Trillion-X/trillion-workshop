/** Whether a placeable row delegates its ordinary click to the generic open-intent owner. */
export function shouldPublishPlaceableIntentOnClick(navigation?: 'local'): boolean {
  return navigation !== 'local';
}
