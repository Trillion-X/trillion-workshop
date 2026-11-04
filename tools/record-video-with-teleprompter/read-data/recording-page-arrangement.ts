// parts/record-video/read-data/recording-page-arrangement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Where one recording's page keeps its own arrangement: the page's content region IS a screen arrangement (the
// embedded-screen-arrangement pattern media-composition uses), opened on the screens the app declares for a recording
// (its `pageScreens` starter, filled from the recording: notes, its transcript) and kept per recording, so a
// recording's notes and the tabs the person arranged come back with that recording and no other.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The part names no screen: which screens a recording opens is the app's DATA (RecordVideoPanel `pageScreens`).
// 2. One address per recording; a saved arrangement holding no tab is set aside for the declared one
//    (EmbeddedScreenArrangementView `starter`), so the page never opens on an empty picker.
//
// =============================================================================

/** The input that reads a saved arrangement by its address (the app's `layout-state-by-address-label`). */
export const RECORDING_PAGE_LAYOUT_STATE_INPUT = 'layout-state-by-address-label';

/** The address one recording's page arrangement is kept at. */
export const recordingPageLayoutAddress = (recordingId: string): string => `record-video-page-layout-state::${recordingId}`;
