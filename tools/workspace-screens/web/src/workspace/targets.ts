// src/workspace/targets.ts
//
// PURPOSE
//   The targets this page answers besides the person's records: the screen arrangement's own math (compiled from
//   crates/screen-arrangement and run here, so every pane and tab change is decided in one place) and the group graph
//   that holds saved layouts, folders and sidebar lists (parts/group, over the same records), and the keeping and
//   reading back of a picture set as a background (backgrounds.ts, in the person's own files), and what a list's DATA
//   names: the tool an action runs and the formula a computed column evaluates (list-targets.ts), and the composition
//   engine that lays out a written page on the Write screen (crates/composition-engine, run in this page as a slot by
//   slot-in-the-page.ts; its bytes are fetched the first time a page is laid out).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No arrangement change is calculated in TypeScript: the compiled arrangement answers every one.
//   2. The group graph reads and writes only through the records target, so a saved layout is the person's record.
//   3. No document layout is calculated in TypeScript: the compiled composition engine answers every one.

import initArrangement, { arrange_screen } from 'screen-arrangement-in-the-page';
import { applyGroupMutationTarget, loadGroupGraphTarget } from '../../parts/group/do-work/group-membership-actions';
import { answerTarget } from './records';
import { keepBackgroundPicture, readBackgroundPicture } from './backgrounds';
import { answerListTargets } from './list-targets';
import { slotAnswer } from './slot-in-the-page';
import { runAddressedResourceAction } from './resource-target';
// The arrangement's compiled bytes, served under their content name (scripts/build-workspace.mjs).
import arrangementBytesAddress from 'screen-arrangement-bytes';
// The composition engine's compiled bytes, served under their content name (scripts/build-workspace.mjs).
import compositionEngineBytesAddress from 'composition-engine-bytes';

let arrangementReady: Promise<void> | undefined;
function ensureArrangementReady(): Promise<void> {
  if (!arrangementReady) {
    arrangementReady = initArrangement({ module_or_path: arrangementBytesAddress }).then(() => undefined).catch(error => {
      // A later arrangement request can retry after a transient module fetch or initialization failure.
      arrangementReady = undefined;
      throw error;
    });
  }
  return arrangementReady;
}

export async function answerTargets() {
  // Register every page target immediately. Focused screens can start without fetching the full workspace's
  // arrangement WASM; its first request loads the shared math on demand.
  const arrange = async (request: unknown) => {
    await ensureArrangementReady();
    return arrange_screen(new TextEncoder().encode(JSON.stringify(request)));
  };
  // The arrangement asks by its slot name and, when that is not answered, by its plain name; both reach the same math.
  answerTarget('slot::screen-arrangement', arrange);
  answerTarget('screen-arrangement', arrange);
  answerTarget('group.load-graph', loadGroupGraphTarget);
  answerTarget('group.apply-mutation', applyGroupMutationTarget);
  answerTarget('content-media-evidence.materialize-artifact', keepBackgroundPicture);
  answerTarget('content-media-evidence.read-guarded-artifact', readBackgroundPicture);
  // What a list's DATA names: a tool an action runs, a formula a computed column evaluates (list-targets.ts).
  answerListTargets();
  answerTarget('addressed-resource.invoke', runAddressedResourceAction);
  // The Write screen's document layout (parts/documents sends every edit to this slot).
  answerTarget('slot::composition-engine', slotAnswer(async () => compositionEngineBytesAddress, 'The page layout'));
}
