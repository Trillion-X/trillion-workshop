// src/workspace/open-record-video.ts
//
// PURPOSE
//   Opens Record video with a format's script about a thought, so a screen that only sends the person there (Formats)
//   opens it without carrying the recorder.

import { openScreenOn } from './open-screen';

type SourceReference = { kind: string; label: string; id: string; title: string };

/** Opens Record video with a format's script about a thought, filled with the person's own material when there is some:
 * the tab named after the format. */
export const openRecordWith = (formatId: string, label: string, about: string, material = '', source: SourceReference | null = null) => openScreenOn('trillion.record-video', { format_id: formatId, about, ...(material ? { material } : {}), ...(source ? { source } : {}) }, label);
