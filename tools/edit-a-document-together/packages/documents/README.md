# Documents

Package-owned authored scene content records and helpers.

Page references use the shared sidebar's caller-owned sections. `pageReferencesToCheck`
preserves stored tokens and groups repeated mentions per containing block. Visible
matching picker records establish resolution; absence from that feed stays “Not
checked”, never “Not found”. The projection supports a confirmed missing result,
but the surface still needs authoritative per-target reads before producing it.
Selecting a reference focuses its existing block without a persistence operation.

The declared `ca-document-index-feed` supplies the sidebar's Saved documents
collection. Opening one uses the shared surface intent and the index reader's
address, address mode and authoritative revision. The caller fixes the destination
to Documents; an index row cannot redirect this control to another package.

Shared headerItems expose New page and All pages. Existing row menus provide Rename, Spacing, Duplicate, Move to top, and Delete; all dispatch existing scene primitives. All pages reuses the existing canvas arrangement/overview operation, preserving page identities. The structured-content import workflow is not a local-file chooser and is not advertised as one.

The page list uses shared `AppSidebar`; page creation changes the scene projection, never main sidebar records. `data/sidebar-config.json` provides the default controls, overridable by `sidebar_capabilities` surface DATA. Screen arrangement supplies `surface_instance_ref` from the durable layout owner and tab id; independent tabs retain independent positions. Standalone mounts lacking that identity keep placement ephemeral rather than sharing a document-wide sidebar setting.

## Rules

- `read-data` is a public source root for packages that need the composition record readers across the package boundary.
- Public source roots describe allowed package source imports before admission. Runtime truth remains admitted log entries, byte addresses, and the log projection.
- Active persistence is `package::documents::authored-scene-content`.
- Scene nodes carry generic children, edges, bindings, triggers, and action references. Product examples stay data records and owner routes, never package backend families.
