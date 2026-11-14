// src/whats-new-rows.mjs
//
// Purpose: what is new in Trillion, as rows of a list, read from the what's-new tours the product ships
// (src/workspace/walkthroughs/whats-new-*.json; every landing ships one). scripts/build-workspace.mjs writes these rows to
// /workspace/whats-new.json on every deploy, so any page (gettrillion.ai/changelog, a docs page, an email, an AI) reads
// what changed from the same records the app's Tours list shows, and nobody types a changelog.
//
//   whatsNewList(tours, { now?, pictures? }) -> { list: { id, label, fields }, rows: [{ id, date, title, summary, points, picture, tour, open }] }
//
// Non-Negotiable Invariants:
//   1. The tours are the only source: a row is derived from its tour and from nothing typed elsewhere.
//   2. A row's date is the date in its tour's id (whats-new-YYYY-MM-DD-...); rows come newest first, and within a day in
//      the order the tours set (`order`), then by id.
//   3. A tour's own `listed` says whether and when its row is shown: { hidden?: true, from?: <ISO>, until?: <ISO> }.
//      A hidden row, or one outside its window at `now`, is left out. No other rule decides it here.
//   4. The title is the tour's first step title when that title is its own (no more than two tours share it); else it is
//      the words of the tour's id, written the way the tour's own words write them (an "ai" the tour writes "AI" reads
//      "AI"). Nothing here names a word to treat specially.
//   5. A picture is the tour's own `picture` ({ src, alt, width?, height? }), else the one `pictures` names for its id
//      (src/workspace/walkthroughs/pictures/pictures.json, kept by scripts/picture-whats-new.mjs); its src is a file in
//      that folder, which the build serves at /workspace/whats-new/<file>.
//   6. A tour may name the board its change belongs on (`board`: { subject, title? }, a decision's case id or any
//      subject words); the row carries it, so tool:keep-a-board puts each landing on that board (src/subject-boards.mjs).
//

const PREFIX = 'whats-new-';
const DAY = /^whats-new-(\d{4}-\d{2}-\d{2})(?:-(.+))?$/;
const PICTURES = '/workspace/whats-new/';

const firstStep = tour => tour.steps?.find(step => step.id === tour.entry_step) ?? tour.steps?.[0];
const payloadOf = step => step?.content?.payload ?? {};
const sentence = text => String(text ?? '').trim();

// Every word the tour itself writes with a capital, so a word of its id can be written the way the tour writes it.
function wordsOfTour(tour) {
  const texts = [tour.summary, ...(tour.steps ?? []).flatMap(step => [payloadOf(step).title, payloadOf(step).body])].filter(Boolean);
  const seen = new Map();
  for (const text of texts) {
    // A word that opens a sentence is capitalised because it opens it; only a capital written mid-sentence says how
    // the tour writes that word.
    for (const match of text.matchAll(/[\p{L}\p{N}']+/gu)) {
      const word = match[0];
      const key = word.toLowerCase();
      const opensSentence = /(^|[.!?:]\s+)$/.test(text.slice(0, match.index));
      if (!seen.has(key) && word !== key && !opensSentence) seen.set(key, word);
    }
  }
  return seen;
}

function titleFromId(tour, slug) {
  const written = wordsOfTour(tour);
  const text = slug.split('-').filter(Boolean).map(word => written.get(word) ?? word).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shownAt(listed, now) {
  if (!listed || typeof listed !== 'object') return true;
  if (listed.hidden === true) return false;
  const at = now.getTime();
  if (listed.from && Date.parse(listed.from) > at) return false;
  if (listed.until && Date.parse(listed.until) <= at) return false;
  return true;
}

function pictureOf(tour, pictures) {
  const picture = tour.picture ?? pictures?.[tour.id];
  if (!picture || typeof picture.src !== 'string' || !picture.src) return null;
  const src = /^https:\/\//.test(picture.src) ? picture.src : `${PICTURES}${picture.src.replace(/^.*\//, '')}`;
  return { src, alt: sentence(picture.alt) || sentence(tour.summary), ...(picture.width ? { width: picture.width } : {}), ...(picture.height ? { height: picture.height } : {}) };
}

// The board a tour's change belongs on (invariant 6): the tour's own `board` { subject, title? }, else none.
function boardOf(tour) {
  const subject = sentence(tour.board?.subject);
  return subject ? { subject, ...(sentence(tour.board.title) ? { title: sentence(tour.board.title) } : {}) } : null;
}

/** The shipped what's-new tours as one list's rows, newest first, as shown at `now`. */
export function whatsNewList(tours, { now = new Date(), pictures = {} } = {}) {
  const news = tours.filter(tour => typeof tour?.id === 'string' && DAY.test(tour.id));
  const titleUse = new Map();
  for (const tour of news) {
    const title = sentence(payloadOf(firstStep(tour)).title);
    if (title) titleUse.set(title, (titleUse.get(title) ?? 0) + 1);
  }
  const rows = news.filter(tour => shownAt(tour.listed, now)).map(tour => {
    const [, date, slug] = tour.id.match(DAY);
    const first = firstStep(tour);
    const own = sentence(payloadOf(first).title);
    const title = own && titleUse.get(own) <= 2 ? own : slug ? titleFromId(tour, slug) : own || sentence(tour.title);
    const points = (tour.steps ?? []).filter(step => step !== first).map(step => {
      const { title: lead, body } = payloadOf(step);
      const head = sentence(lead).replace(/[.!?]$/, '');
      return [head, sentence(body)].filter(Boolean).join('. ');
    }).filter(Boolean);
    return {
      id: tour.id.slice(PREFIX.length),
      date,
      order: typeof tour.order === 'number' ? tour.order : null,
      title,
      summary: sentence(tour.summary) || sentence(payloadOf(first).body),
      points,
      picture: pictureOf(tour, pictures),
      tour: tour.id,
      open: `/?tour=${encodeURIComponent(tour.id)}`,
      ...(boardOf(tour) ? { board: boardOf(tour) } : {}),
    };
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
  return {
    list: {
      id: 'whats-new',
      label: 'What is new',
      title_field: 'title',
      fields: [
        { id: 'title', label: 'Change', kind: 'text' },
        { id: 'date', label: 'When', kind: 'date' },
        { id: 'summary', label: 'What it does', kind: 'long-text' },
        { id: 'points', label: 'How it works', kind: 'tags' },
        { id: 'picture', label: 'Picture', kind: 'picture' },
        { id: 'tour', label: 'Tour', kind: 'tour' },
        { id: 'open', label: 'Open', kind: 'link-address' },
      ],
    },
    rows: rows.map(({ order, ...row }) => row),
  };
}
