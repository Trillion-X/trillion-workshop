# tools/show-the-media-library-and-search-what-was/

Show the media library and search what was said or seen in recordings, and change the next-edit suggestion.

`tool:answer-the-media-page` (`do-work/answer-the-media-page.mjs`, `tool-rows.json`) answers the Media page's saved edits, `GET`/`POST /media/edit`, by running old trillion's `src/work-media.mjs` `handleWorkMedia` unchanged over the person's `media-edit` records. Each saved clip is kept as edited through the files door's `record_file_use`. The engine runs it as a `@workshop-routes` tool. Edits in a shared project, the library, next-edit, render, transcribe and the editor hand-off need engine abilities this run does not have. Those requests answer 503 with words, or, for a run that cannot start, the old handler's own 400. `test/answer-the-media-page.test.mjs` ports the edit cases of the tag's `test/work-media.test.mjs` and `test/native-browser-media.test.mjs`.

The folder's other old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.
