# tools/find-and-keep-my-connections/

`read-data/connector-finds.mjs` answers the account's last connector search and the first page of the catalogs from old
`src/connector-finds.mjs`. It keeps nothing and reads no records: the host hands in the finds it kept (`env.earlier`, `{ own,
everyone }`, each `{ found, expires_at }`), a find still fresh is answered without asking a catalog, and the find to keep comes
back as `to_keep` for the host's own write. Each find is good for one hour. A failed catalog remains explicitly unreached in
its catalog answer. No Worker KV or user-id-selected store is used.

Files more than one moved group imports, kept once.

Earlier files were moved byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json`
records that original move. The new adapter above instead replaces the retired Worker's storage boundary with an earlier find
handed in and a find returned to keep. Its separate source baseline and port contract describe that adaptation.
