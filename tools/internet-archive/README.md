# Internet Archive search tools

This folder contributes two read-only tools to Trillion's shared Workshop catalog: bounded Advanced Search and item metadata lookup. The common Workshop makes them discoverable by job across objectives; no video editor dependency is involved.

The tools call Internet Archive's free public JSON endpoints over HTTPS. Search returns a bounded page and asks Archive to omit records marked `access-restricted-item:true`. It returns identifiers, source metadata, collection, license URL and rights fields when Archive indexes them. Metadata lookup is restricted to an Archive identifier and returns the item's metadata and available-file listing; it never downloads media bytes. The canonical item page is `https://archive.org/details/<identifier>`.

Archive availability and collection membership do not establish permission to reuse a work. Preserve the item URL, identifier, creator, collection and exact license/rights statements. Treat missing or ambiguous rights as unknown, and check the intended use independently. This matters especially for concert recordings and the George Blood 78rpm collection: its description limits use to research, teaching and private study and says copyright was not transferred to Archive. Do not use either endpoint as a blanket “free to reuse” filter.

## Files

| File | Purpose |
|---|---|
| `records.json` | Shared Workshop descriptors for Archive search and metadata lookup. |
| `tool-rows.json` | The tool-row source that lists `records.json`'s rows into the Workshop. |
| `part.json` | No public files. |
