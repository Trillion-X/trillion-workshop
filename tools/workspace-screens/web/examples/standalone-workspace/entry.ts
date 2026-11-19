// examples/standalone-workspace/entry.ts
//
// PORTED FROM: src/workspace/main.tsx and the seam proof (entry2.tsx), reduced to the sidebar and the screen
// arrangement, which the page mounts from a records source the page gives it (setWorkspaceRecordsSource).
//
// PURPOSE
//   Starts the workspace on this page: mounts one records source (seeds.ts), answers the arrangement's and the group
//   graph's targets, installs the screen runner with this page's screens, and mounts the sidebar and the arrangement.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The source is mounted before anything reads or writes records.
//   2. The screens are the entries of `screens` below; the sidebar rows (seeds.ts) name them, nothing else is drawn.

import '../../src/workspace/workspace.css';
import { seededRecordsSource, setWorkspaceRecordsSource } from '../../src/workspace/records-source.ts';
import { setRecordsDoor } from '../../src/workspace/records-door';
import { seededRecordsDoor } from '../../src/workspace/records-door-seeded';
import { answerTargets } from '../../src/workspace/targets';
import { installScreenRunner } from '../../src/workspace/screen-runner';
import type { WarmMount } from '../../src/workspace/lazy-screen';
import mountSidebar from '../../../../sidebar/show/mount-sidebar';
import mountArrangement from '../../../../screen-arrangement/show/mount-screen-arrangement';
import { mount as mountLesson } from '../../../../lessons-and-learning-paths/web/course-lesson-screen-mount';
import { mount as mountCourses } from '../../../../lessons-and-learning-paths/web/course-list-screen-mount';
import { mount as mountPosts } from '../../../../social-posts/web/src/workspace/posts-screen-mount';
import mountChat from '../../../../chat/show/mount-chat';
import mountAccount from '../../../../account-dashboard/packages/account-dashboard/show/mount-account-dashboard';
import { DOOR_ROWS, LIST, PACKAGE, SEEDS } from './seeds';

// The screens this page offers, by entry name. Each is a Workshop screen's own mount.
// A lesson is the lessons package's own screen: a course list opens it by that package's entry name.
const screens: Record<string, WarmMount> = {
  courses: (element, props) => mountCourses(element, props.surfaceInput ?? {}),
  'lessons-and-learning-paths/course-lesson-screen-mount': (element, props) => mountLesson(element, props.surfaceInput ?? {}),
  posts: (element, props) => mountPosts(element, props),
  chat: (element, props) => mountChat({ el: element, props: props.surfaceInput ?? {} }),
  account: element => mountAccount({ el: element }),
};

setWorkspaceRecordsSource(seededRecordsSource(SEEDS));
const door = seededRecordsDoor(DOOR_ROWS);
setRecordsDoor(door);
(window as unknown as { seededRecords: () => unknown }).seededRecords = () => door.rows();
await answerTargets();
installScreenRunner(screens, LIST);

const sidebarEl = document.getElementById('sidebar')!;
const arrangementEl = document.getElementById('arrangement')!;

mountSidebar({ el: sidebarEl, props: { surfaceInput: {
  scope: PACKAGE,
  persist_collection_edits: true,
  placeable_surface_list_address_label: LIST,
} } });
mountArrangement({ el: arrangementEl, props: {
  placeableSurfaceListAddressLabel: LIST,
  surface_collections_scope: PACKAGE,
  persist_collection_edits: true,
  surface_intent_destination_ref: `destination:${PACKAGE}`,
  // A lesson is opened from the course list, so it is not one of the sidebar's entries: a saved tab for it is kept.
  tabsOutsideCatalog: 'keep',
} });
