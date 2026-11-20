// tools/photograph-each-whats-new-tour-live-on-a-fresh-account/do-work/pick-and-name-pictures.mjs
//
// Purpose: the pure parts of giving each what's-new tour its picture. Which tours still need one, the picture's file name,
// the pictures.json entry it gets, and the step the picture is taken at. It reads no disk and starts no browser: the caller
// reads the tour files and pictures.json, runs the capture, and writes the result. Ported from the old script
// scripts/picture-whats-new.mjs (held copy: ../from-an-older-version/scripts/picture-whats-new.mjs.held).
//
//   tourPicturesWanted(entries, { pictures?, named? }) -> [{ file, tour }]   entries: [{ file, tour }], the tour files as read
//   pictureFileOf(tour) -> '<tour id>.webp'
//   shownStepOf(tour) -> the step the picture is taken at, or null when the tour has no steps
//   pictureEntryOf(tour, step, { width?, height? }) -> { src, alt, width, height }, the pictures.json entry for the tour
//   picturesWith(pictures, tourId, entry) -> a new pictures object with the entry set, keys in name order
//
// Non-Negotiable Invariants:
//   1. Only tour files named whats-new-YYYY-MM-DD*.json are candidates, in file-name order.
//   2. Named tour ids (argv) are taken again even when they already have a picture. Without names, a tour is wanted when it
//      has no picture of its own (`tour.picture`) and pictures.json has no entry for its id.
//   3. The picture is taken at the last step that points at something (target_ref or target_preparation), else at the last
//      step. Words of the step: its title and body, else the tour's summary.
//   4. The picture is named by the tour's id, so the same tour always writes the same file and the same pictures.json key.
//   5. Nothing here reads a file, a browser or a clock; every input is passed in, and no input is changed.

export const PICTURE_WIDTH = 1280;
export const PICTURE_HEIGHT = 800;

const TOUR_FILE = /^whats-new-\d{4}-\d{2}-\d{2}.*\.json$/;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function tourPicturesWanted(entries, { pictures = {}, named = [] } = {}) {
  const wanted = new Set(named);
  return [...entries]
    .filter(({ file, tour }) => TOUR_FILE.test(file) && tour && typeof tour === 'object')
    .sort((a, b) => byName(a.file, b.file))
    .filter(({ tour }) => (wanted.size ? wanted.has(tour.id) : !tour.picture && !pictures[tour.id]))
    .map(({ file, tour }) => ({ file, tour }));
}

export function pictureFileOf(tour) {
  return `${tour.id}.webp`;
}

export function shownStepOf(tour) {
  const steps = tour.steps ?? [];
  if (steps.length === 0) return null;
  return [...steps].reverse().find(step => step.target_ref || step.target_preparation) ?? steps.at(-1);
}

export function pictureEntryOf(tour, step, { width = PICTURE_WIDTH, height = PICTURE_HEIGHT } = {}) {
  const payload = step?.content?.payload ?? {};
  const alt = [payload.title, payload.body].filter(Boolean).join(': ') || tour.summary;
  return { src: pictureFileOf(tour), alt, width, height };
}

export function picturesWith(pictures, tourId, entry) {
  return Object.fromEntries(Object.entries({ ...pictures, [tourId]: entry }).sort(([a], [b]) => a.localeCompare(b)));
}
