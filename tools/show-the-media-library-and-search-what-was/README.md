# tools/show-the-media-library-and-search-what-was/

Show the media library and search what was said or seen in recordings, and change the next-edit suggestion.

`tool:answer-the-media-page` (`do-work/answer-the-media-page.mjs`, `tool-rows.json`) answers the Media page's saved edits, `GET`/`POST /media/edit`, by running old trillion's `src/work-media.mjs` `handleWorkMedia` unchanged over the person's `media-edit` records. Each saved clip is kept as edited through the files door's `record_file_use`. The engine runs it as a `@workshop-routes` tool. Edits in a shared project, the library, next-edit, render, transcribe and the editor hand-off need engine abilities this run does not have. Those requests answer 503 with words, or, for a run that cannot start, the old handler's own 400. `test/answer-the-media-page.test.mjs` ports the edit cases of the tag's `test/work-media.test.mjs` and `test/native-browser-media.test.mjs`.

The folder's other old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Screens

The screens of this tool's Media page.

| File | Purpose |
|------|---------|
| `web/src/workspace/media-screen.tsx` | The Media screen (`tool:screen-media`): the person's recordings and the files their tools made, with the next-edit suggestion, the shared record views, the facts kept about each file and a search that turns the list into moments. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `web/src/workspace/note-list.ts` | What the Notes list adds to a row's menu: the kept transcript as a PDF. Only the Media screen imports it. |
| `web/src/workspace/recency-group.mjs` | The recency group a row falls in on the Notes list; its boundaries and words are DATA in the web shell's `note-list-menu.json`. Only the Media screen imports it. |
| `web/src/workspace/media-edit-screen.tsx` | The Media edit screen (`tool:screen-media-edit`): the clips chosen from Media played and reviewed in the shared player, with the cut timeline and the side panels. Moved as the Media screen was. |
| `web/src/workspace/media-edit/` | The media editor's side panels and cut-editing parts, mounted by the Media edit screen; its own `README.md` lists them. Only that screen imports them. |
| `show/media-mount.tsx, show/media-edit-mount.tsx` | The module entries of the two screens, the files their rows name: `mount` is each screen's own mount function. |
