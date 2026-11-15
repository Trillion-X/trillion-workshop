# tools/find-and-keep-my-connections/

`read-data/connector-finds.mjs` restores the account's last connector search and the shared first-page cache from old
`src/connector-finds.mjs`. The host supplies current catalog data and the invoking account's records door; an optional
shared door is separately bound by that host. Cache rows expire after one hour. A failed cache read stays an error,
while a failed catalog remains explicitly unreached in its catalog answer. No Worker KV or user-id-selected store is used.

Files more than one moved group imports, kept once.

Earlier files were moved byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json`
records that original move. The new adapter above instead replaces the retired Worker's storage boundary with the
current records door. Its separate source baseline and port contract describe that adaptation.
