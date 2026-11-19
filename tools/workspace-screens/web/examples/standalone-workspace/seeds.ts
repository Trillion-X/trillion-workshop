// examples/standalone-workspace/seeds.ts
//
// PURPOSE
//   Made-up rows the example page starts from: the sidebar's list, its four screens and the saved state the screens read
//   at start. A host page supplies its own rows the same way (see README.md, "What a host page provides").
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every screen row names an entry the page mounts (`ENTRY_OF`), and nothing else is mounted.
//   2. The rows are the record shape the placeable-surface readers decode (`payload.kind` `placeable-surface`).

export const PACKAGE = 'standalone-workspace';
export const PLACEMENT = PACKAGE;
export const LIST = `placeable-surface-list::${PLACEMENT}`;

const surface = (id: string, label: string, entry: string, order: number, surfaceInput: Record<string, unknown> = {}) => ({
  record: { address: id },
  payload: {
    kind: 'placeable-surface',
    id,
    label,
    material_target: id,
    placement_labels: [PLACEMENT],
    order,
    package_entry: { package_name: PACKAGE, entry_name: entry },
    surface_input: surfaceInput,
  },
});

// The sidebar's entries, in order. The entry names are the keys of the page's screen map (entry.ts). The course list
// names the lesson field its video is read from; a lesson opened from the list carries its own input.
export const SURFACES = [
  surface('courses', 'Courses', 'courses', 1, { video_field: 'video_url' }),
  surface('posts', 'Posts', 'posts', 2),
  surface('chat', 'Chat', 'chat', 3),
  surface('account', 'Account', 'account', 4),
];

// The learner's records the course screens read through the records door (records-door-seeded.ts). Lesson 1's video is
// a file this example serves beside the page.
export const DOOR_ROWS = [
  { id: 'course-intro', type: 'record:course', value: { title: 'Starting out', about: 'Two short lessons.', lesson_ids: ['lesson-1', 'lesson-2'] } },
  { id: 'lesson-1', type: 'record:lesson', value: { title: 'Welcome', body: 'What this course covers.', video_url: { playback_url: './sample-lesson.webm', mime_type: 'video/webm' } } },
  { id: 'lesson-2', type: 'record:lesson', value: { title: 'Next steps', body: 'What to try after the welcome.' } },
];

export const SEEDS: Record<string, unknown> = {
  [LIST]: SURFACES,
  'placeable-surfaces': SURFACES,
  [`package::sidebar::reply-provider-feed`]: SURFACES,
  [`package::screen-arrangement::screen-reply-provider-feed`]: SURFACES,
  [`package::screen-arrangement::placeable-surface-input-overrides::${encodeURIComponent(LIST)}`]: [],
  'screen-arrangement-own-layouts': [],
};
