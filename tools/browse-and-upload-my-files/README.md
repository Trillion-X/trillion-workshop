# tools/browse-and-upload-my-files

Browse and upload a person's files and folders in their Trillion space. The sending side (`do-work/`,
`built-stored-bytes/`, `send-settings.json`) puts a file or folder into the person's namespace; the Files screen is where
the person browses, searches and uploads them.

## Files

| File | Purpose |
|------|---------|
| `do-work/` | The sending side: content chunks, the namespace client, the send of a file and of a folder, the send window and retry, sending without copies, byte identity and the shared file reference |
| `built-stored-bytes/` | The built content-chunks module the sending side loads |
| `send-settings.json` | The settings the sending side reads |
| `ports/` | The port contracts of the sending side's files |
| `web/src/workspace/files-screen.tsx` | The Files screen (`tool:screen-files`): the person's folders and files drawn by the shared record views from the listing of one folder at a time, the one search with where each file matched, and upload by choosing or dropping files. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/files-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
| `moved-from.json` | Where each moved file came from, with the identity of its bytes there and here |
| `README.md` | This file |
