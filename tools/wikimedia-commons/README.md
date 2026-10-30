# Wikimedia Commons source tools

These read-only tools are listed in the shared Workshop for any objective that needs real images or other Commons files. Search is scoped to File pages and returns a bounded page of file titles and canonical page URLs; metadata lookup reads one exact `File:` title and asks for its latest file revision and extended metadata, including license and attribution fields. Neither operation downloads media bytes.

Search for the exact place, object, event or other subject first. Keep each Commons page URL with the candidate. Use **Assess Commons file reuse and prepare credit** on each candidate's page object before selecting it for reuse. That local check admits only an explicit Public Domain declaration with `Copyrighted=false`, the Public Domain Mark 1.0, CC0 1.0, or an exact CC BY 1.0/2.0/2.5/3.0/4.0 declaration and matching canonical license URL. It refuses BY-SA, NC, ND, unknown, missing or conflicting license metadata, and missing author/source credit fields. Its `eligible_for_selection` result means eligible under the stated license policy; it does not establish every other right or guarantee the intended use.

The assessor keeps original license, author, title, source and rights metadata, derives a text attribution, records declared changes, and returns explicit warnings. Treat all `extmetadata` values as untrusted text; do not render embedded HTML. Inspect the source page and the intended-use rights independently, including any restrictions. Commons hosting or search visibility alone grants no reuse permission.

## Files

| File | Purpose |
|---|---|
| `records.json` | Shared Workshop descriptors for search, one-file metadata and the local rights/credit check. |
| `tool-rows.json` | The tool-row source that lists `records.json`'s rows into the Workshop. |
| `part.json` | No public files: only the tool runs this code. |
| `do-work/assess-commons-reuse.mjs` | Offline, conservative, file-specific license classification and credit preparation. |
| `test/assess-commons-reuse.test.mjs` | The license policy, the credit text and the command as its row runs it. |

Search accepts a bounded `limit` (1–50) and numeric `offset` (0–500). It uses the search generator with page info, so `continue.gsroffset` advances search results without mixing in file-revision pagination. Stop when that search continuation is absent. Read license metadata only for selected candidates using the exact File lookup, with `iilimit=1` (latest revision); never request up to 500 historical revisions to hide a revision continuation. Metadata lookup refuses URLs, multi-title pipes, fragments and line breaks, and passes the title as an encoded query parameter.

The official [Imageinfo documentation](https://www.mediawiki.org/wiki/API:Imageinfo) defines `iilimit` as file revisions per file and identifies extended metadata as expensive. These discovery and metadata operations are intentionally separate.
