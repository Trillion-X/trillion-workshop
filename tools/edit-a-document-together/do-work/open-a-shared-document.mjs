// tools/edit-a-document-together/do-work/open-a-shared-document.mjs
//
// Which document a page of Write opens, so the people of one pursuit edit the same document together: a page opened
// in a pursuit (space_id) opens that pursuit's one shared room (show/write-screen.json shared_place + the pursuit +
// shared_scene) unless it names a document of that same room; a page opened with no pursuit keeps its own personal
// address. It runs show/write-screen-input.mjs writeScreenInput, the rule the Write screen opens with.
//
// Input:  { pages: [{ space_id?, scene_address?, ...anything else the page was opened with }] }
// Answer: { pages: [{ opened: true, input, shared } | { opened: false, refused }], shared_rooms: [address] }
//         input is what the screen opens with; shared says it is a pursuit's room; shared_rooms lists each room once.
// A page this rule refuses (a pursuit name that is empty, not text or holds '/', or a document of another room) is
// answered refused with the screen's own words; nothing falls back to a personal page. Reads and keeps nothing.
import settings from '../show/write-screen.json' with { type: 'json' };
import { writeScreenInput } from '../show/write-screen-input.mjs';

const owner = { sharedPlace: settings.shared_place, sharedScene: settings.shared_scene };

export function openASharedDocument({ pages } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('Give pages: a list of what each page is opened with, e.g. [{ "space_id": "garden-club" }, {}].');
  const rooms = new Set();
  const answered = pages.map(page => {
    try {
      const input = writeScreenInput(page, owner);
      const shared = typeof input.scene_address === 'string' && input.scene_address.startsWith(owner.sharedPlace);
      if (shared) rooms.add(input.scene_address);
      return { opened: true, input, shared };
    } catch (error) {
      return { opened: false, refused: error.message };
    }
  });
  return { pages: answered, shared_rooms: [...rooms] };
}
