# Hash content with BLAKE3

`tool:hash-content-with-blake3` returns `{ blake3, identity, bytes }` for exactly one of:

- `{ "text": "abc" }`: exact UTF-8 bytes, including whitespace and empty text.
- `{ "path": "research/source.pdf" }`: raw bytes of a regular file under the granted Files folder. Absolute paths, traversal and symlinks outside that folder are refused.

Uses `content-identity/read-data/identity.mjs`'s `makeHashCodeHexFromBytes`; no separate hash implementation. `blake3` is 64 lowercase hex digits; `identity` includes the canonical `1f:` prefix. No file is changed. Files are read into memory, so memory use grows with file size.

Local call: `echo '{"text":"abc"}' | node tools/hash-content-with-blake3/do-work/hash-content.mjs`

For Files, append the absolute granted folder to the command. The Workshop descriptor mounts the same owner and its declared noble dependency. Test: `node --test tools/hash-content-with-blake3/test/*.test.mjs`.

Landing this tool does not move the Workshop pin; it becomes available through the engine after the pin owner includes this commit.
