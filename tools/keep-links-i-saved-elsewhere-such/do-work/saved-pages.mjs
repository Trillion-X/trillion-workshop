// tools/keep-links-i-saved-elsewhere-such/do-work/saved-pages.mjs
//
// The saved-page tools a row runs on the person's computer (run-a-function.mjs calls each export as fn(input, host)): a web
// page kept as a clip in the person's Files, read, edited and refreshed. The page's engine is src/saved-pages.mjs; this file
// only gives it the run's host actions: the Files right (read and write whole files, read-data/whole-file.mjs) and another
// Workshop tool's answer (host.run, which reads the page with tool:read-a-page-in-my-browser).
//
// Non-Negotiable Invariants:
//   1. The page and its index are written only through the host's Files right, the same road as keep-a-local-file-in-my-files,
//      so the Files screen and every AI read one copy.
//   2. A run without the Files right is refused with its own code (no_files) and is never answered as "no saved page".
//   3. The removal of a page is not in this module: Recently Deleted needs a Files operation that no row declares yet, so
//      remove is refused by name until one does.
//
//   savePage(input, host), readSavedPage(input, host), editSavedPage(input, host), refreshPages(input, host) -> the engine's answer
//   findLinkProvider(input) -> which registered provider a pasted address belongs to (no files, no host; a link no provider handles is refused)
import { makeSavedPages, SavedPagesError } from '../src/saved-pages.mjs';
import { findLinkProvider as providerOf } from '../src/saved-links.mjs';
import { readWholeFile, writeWholeFile } from '../../workflows/read-data/whole-file.mjs';

// The code the files right answers for a name that is not there: proved on the Mac by find_file on a missing name (Nov 20 2026, 5:44 AM CST).
const MISSING_FILE = 'namespace_not_found';
const REMOVE_REFUSAL = 'Removing a saved page needs a Files delete operation that no row declares yet, so nothing was removed.';

// The Files right as the engine's page store sees it. A file that is not there reads as null; every other failure is raised,
// so a run without its host actions says so instead of answering as an empty list.
function filesOf(host) {
  return {
    read: async name => {
      try {
        const held = await readWholeFile(host, name);
        return held.bytes ? held.bytes.toString('utf8') : null;
      } catch (error) {
        if (error?.code === MISSING_FILE) return null;
        throw error;
      }
    },
    write: (name, body, mediaType) => writeWholeFile(host, name, Buffer.from(body), { mediaType }),
    remove: async () => { throw Object.assign(new SavedPagesError(REMOVE_REFUSAL), { code: 'refused' }); },
  };
}

function pagesOf(host) {
  return makeSavedPages({ files: filesOf(host), run: (tool, input) => host.run(tool, input) });
}

export async function savePage(input = {}, host) { return pagesOf(host).savePage(input); }
export async function readSavedPage(input = {}, host) { return pagesOf(host).readSavedPage(input); }
export async function editSavedPage(input = {}, host) { return pagesOf(host).editSavedPage(input); }
export async function refreshSavedPages(input = {}, host) { return pagesOf(host).refreshPages(input); }

export async function findLinkProvider(input = {}) { return providerOf(input.url); }
