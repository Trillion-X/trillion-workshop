# tools/move-a-shared-spaces-content-into-its-own-store/

Move a shared space's content into its own store and clear the old copy only after the new one reads back exactly.

This folder has no row yet. Its old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.
