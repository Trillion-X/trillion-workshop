// parts/documents/show/write-screen.tsx
//
// NO PRIOR: searched ~/dev/bitfield-packages/packages/*/show for "write screen" and "mountWriteScreen" (none). This is
// Trillion's own src/workspace/write-screen.tsx moved here whole; only its imports and its export's name changed.
//
// PURPOSE
//   Write (tool:screen-write): the documents surface (mount-documents.tsx) as a screen of its own. It is a screen module
//   (scripts/screen-modules.mjs): built from this tool folder into its own bundle, kept in the namespace and imported by
//   the page when Write first opens (src/workspace/tool-screen.tsx, kind `module`), so the page every person downloads
//   never carries it; React, the records seam and the shared parts are the page's own, reached through its import map.
//   Personal pages, their list and every edit are kept in the person's own records (`package::documents::documents`,
//   through #workspace-records). Opened with space_id, its pages live in that pursuit's existing shared room, using
//   record-places.json and the same membership-checked owner as board documents. The composition engine that lays a page out runs in the page (crates/composition-engine,
//   src/workspace/targets.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The surface is the package's own; this file only hands it the feeds the package manifest declares
//      (../things-to-store-and-run.json, read by #workspace/part-records.ts) and mounts it.
//   2. The feeds are the page's DATA, never saved to the person's store.
//   3. The pages rail uses the shared sidebar's per-instance contained placement and its configured capabilities
//      (`sidebar_capabilities`, write-screen.json), independently of the app rail and pane tabs. Its reading width,
//      margins and type sizes are the look `parts/screen-look/show/write-page.css`, under the class the screen's
//      element carries.
//   4. One export, `mount(element, { surfaceInput })`, returning how to take the screen down: the module kind's contract.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import manifest from 'trillion-workshop/tools/edit-a-document-together/things-to-store-and-run.json';
import mountDocuments from './mount-documents';
import { partManifestFeeds } from '#workspace/part-records.ts';
import { showMissing } from '#workspace-records';
import settings from 'trillion-workshop/tools/edit-a-document-together/show/write-screen.json';
import { writeScreenInput } from 'trillion-workshop/tools/edit-a-document-together/show/write-screen-input.mjs';
import { yourFiles, readNamespaceText } from '../../../src/workspace/your-files';
import { uploadFiles } from '../../../src/workspace/upload';
// Ask AI hands what the person asks to their own AI and places its answer (#workspace/ask-my-ai.ts answers the
// surface's `ask-my-ai:` dispatch).
import '#workspace/ask-my-ai.ts';

let fed = false;

export function mount(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  if (!fed) {
    showMissing(partManifestFeeds(manifest));
    fed = true;
  }
  element.classList.add(settings.look_class);
  const surfaceInput = { sidebar_capabilities: settings.sidebar_capabilities, sidebar_settings: settings.sidebar_settings,
    ...writeScreenInput(props.surfaceInput ?? {}, { sharedPlace: settings.shared_place, sharedScene: settings.shared_scene }) };
  // Opening Write from a pursuit keeps every page in its existing live room.
  // An explicit board document retains its address and the room rechecks membership.
  const unmount = mountDocuments({ el: element, props: {
    ...props,
    floating_frame: settings.floating_frame,
    surfaceInput,
    fileSource: yourFiles,
    readFileText: readNamespaceText,
    savePortableFile: async ({ name, folder, text, mediaType }: { name: string; folder: string; text: string; mediaType?: string }) => {
      const destination = folder.trim() || '/';
      if (!destination.startsWith('/') || destination.includes('..')) throw new Error('Choose a valid Files folder.');
      const [stored] = await uploadFiles([new File([text], name, { type: mediaType ?? 'application/octet-stream' })], destination);
      if (!stored?.name) throw new Error('The composition file was not saved.');
      return stored.name;
    },
  } });
  return () => { unmount(); element.classList.remove(settings.look_class); };
}
