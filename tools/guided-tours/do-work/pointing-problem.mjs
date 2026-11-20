// tools/guided-tours: what is wrong with how a tour step shows its thing, or null. Pure: the rule (what shows itself,
// what counts as too vague, what is on every screen) is the tour screen's DATA, passed in by the caller
// (tools/tours-screen/read-data/tours.json `pointing`). Ported from the older Workshop copy of src/tours.mjs pointingProblem
// (commit b6ae0ebf81); the messages are the old ones.

const text = value => (typeof value === 'string' ? value.trim() : '');

// It points at a particular control, opening the screen that control is on first, or it holds the thing live in the card.
export function pointingProblem(step, pointing) {
  if (pointing.shows_itself.includes(text(step.content?.content_kind))) return null;
  const query = text(step.target_ref?.query);
  if (!query) return 'points at nothing: give it target_ref { from: "selector", query } naming the real control it talks about (read_layouts names the screens; open one with target_preparation), or hold the thing in the card (placeable-surface).';
  const parts = query.split(',').map(part => part.trim().toLowerCase());
  if (parts.every(part => pointing.too_vague.includes(part))) return `points at "${query}", which is the whole page, not a control: name the control itself (a [data-…] or aria-label selector).`;
  const pageWide = parts.some(part => pointing.page_wide.some(prefix => part.startsWith(prefix.toLowerCase())));
  if (!pageWide && !text(step.target_preparation?.surface?.id)) return `points at "${query}" inside a screen without opening it: add target_preparation { surface: { id } } with the screen that control is on (read_layouts lists them).`;
  return null;
}
