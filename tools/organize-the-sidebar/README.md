# tools/organize-the-sidebar/

The one owner of the sidebar and of the group board.

- The sidebar: the lists of screens and rows a person sees, the rules that fill or hide a list, the colours and places of rows, and the notes an AI leaves on rows (`sidebar/part.json`, `show/`, `read-data/`, `do-work/`).
- The group board (a pursuit's shared canvas or a person's own): its screen is the `tool:screen-board` offer in `part.json` (`show/board-screen.tsx`); its records, transitions and shared pieces are in `read-data/`, `do-work/` and `show/`, listed in `group/part.json`.
- The vision-board screen (`packages/vision-board`, `from-bitfield-packages`).

This folder took in the former `tools/group`, which held a second copy of the group board code. Its newer files (the share text codec, the cleaned wording, `read-data/kept-library.ts`) are here, its callers import from here, and the folder is gone.

The vision-board part:

Moved here byte for byte from Trillion-X/bitfield-packages by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/bitfield-packages imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.
