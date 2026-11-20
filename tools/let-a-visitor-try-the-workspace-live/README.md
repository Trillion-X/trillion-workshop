# tools/let-a-visitor-try-the-workspace-live/

Let a visitor try Trillion's own workspace live in a throwaway account that empties itself when its time ends.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

Ported here: `src/showcase-spare-facts.mjs` (a copy of `from-an-older-version/src/showcase-spare-facts.mjs`, only its import of `showcases.json` now points at `tools/showcases/`), tested by `test/showcase-spare-facts.test.mjs`. It has no caller yet: the live showcase runtime that reads it (`from-an-older-version/src/showcases.mjs.held`) has no current owner. The gap is recorded in `verify-every-port/let-a-visitor-try-the-workspace-live`.
