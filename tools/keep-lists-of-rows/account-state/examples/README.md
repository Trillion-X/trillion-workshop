# Original snapshot inspection

`inspect_original.rs` reads one private JSON request from stdin. It calls the
Rust original-data adapter and prints only row/column counts and a typed-result
BLAKE3. It accepts no secret or original identity through argv, and never prints
the original row values.

The exact request contract, provenance requirements and remaining migration
limits are in [import](../docs/import.md). The example uses the library's pinned
read-only adapter; it does not start the old application or contact Cloudflare.
