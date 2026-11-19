# tools/show-the-signed-in-persons-message-inbox-and-tell/

Show the signed-in person's message inbox and tell the sender whether the AI can be reached or will find the message later.

The route's row is `tool-rows.json` (`tool:answer-the-message-page-routes`). It holds no database and calls no records method: the caller reads the person's message rows from their own store and gives them as `stored.records`, and the rows a send makes come back in `keep` for the caller to write as new rows; a correction (`/messages/correct`) comes back as one row with `replaces: true`, which the caller updates in place. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.
