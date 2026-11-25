# tools/workspace-screens/web/members-page/

The generic members page: the Workshop's own workspace (the sidebar from `tools/sidebar`, the screen arrangement from
`tools/screen-arrangement`) for the person a site's host says is signed in. Any site that has signed-in members serves this
page; the site holds only its rows and its server routes. The page holds no site code and no screen map.

## Files

| File | Purpose |
|------|---------|
| `entry.ts` | The page: reads the host block, asks the host who is signed in, mounts the records source, the door, the sidebar and the arrangement, and installs the screens. |
| `host.ts` | The host block's reader and the transports (records, door, subject). A 401 from the subject sends the person to the sign-in. |
| `rows.mjs` | The pure rules: a screen module's key, a sidebar row's screen key, and the host values a row takes. Browser-safe. |
| `registry.mjs` | Finds the screen modules of the packages a site names (Node only; the build uses it). |
| `build.mjs` | `buildMembersPage({ out, host, packages, shell })`: builds the page for one site. |
| `index.html`, `members-page.css` | The shell (an empty host block the build fills) and its stylesheet. |

## What a host provides

1. A host block: `<script id="members-host" type="application/json">`, filled by `buildMembersPage` from `host`:
   `placement` (the sidebar list is `placeable-surface-list::<placement>`), `subject` (the signed-in person: a JSON answer,
   and 401 when nobody is signed in), `records` (the records source's reads and writes), `door_record`, `door_list`,
   `door_write` (the records door), optionally `tours` (the records label the host answers the signed-in person's own
   walkthrough-definition records under; the page runs them with `tools/guided-overlay` and says `first-use-ready` once), and optionally `sign_in`, the host's own sign-in page, which a signed-out visitor is sent to with `next` set to where they were (without it, the workspace's sign-in address). Optionally `start`: the sidebar rows (by id, first available wins) an empty pane opens on, the
   arrangement's `empty_container_surface_ids`, so the first screen a member sees is the site's home rather than a blank panel.
2. Sidebar rows: placeable-surface records in the records source at the placement's list. Each row's `package_entry` names its
   screen: `package_name` is the Workshop package that holds the screen module, `entry_name` the module's file name without
   `.tsx` (for example `billing-screen-mount`). The page's key for it is `package_name/entry_name`.
3. The row's `surface_input` is the screen's input. `host_input` in it names the host values the screen takes (for example
   `["subject_email", "subscription_id"]`); nothing else from the host reaches a screen.
4. `packages`: the Workshop packages whose screen modules the page carries. Every `*-screen-mount.tsx` file under a package's
   `web/` folder is a screen module; two with one key are refused at build time.

A screen module exports `mount(element, props)`. The page gives it its row's input both flat (`props.<name>`) and as
`props.surfaceInput`.

## Known limits

- The page's sidebar and screens are only as complete as the rows: a row whose screen the page does not carry opens the screen
  runner's empty state (`screen-runner.ts`), it is not hidden.
- The course list opens its lesson by `lessons-and-learning-paths/course-lesson-screen-mount`; that package must be in `packages`.

Tests: `tools/workspace-screens/test/members-page-rows.test.mjs`.
