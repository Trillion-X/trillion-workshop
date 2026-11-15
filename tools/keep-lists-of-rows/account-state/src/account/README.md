# Account

The account's own door for people and AIs: who is signed in (`signed_in.rs`: a Better Auth JWT checked against its JWKS;
sign-in itself is the Workshop tool trillion-workshop tools/better-auth), its door operations (`account_routes.rs`),
making an account (`create.rs`), and its computers (`computers/`, `computers.rs`: which computers keep it, which
answer, who writes, and how many copies it keeps, `computers/README.md`).

| Path | Job |
| --- | --- |
| `signed_in.rs`, `signed_in/settings.json` | The one check of who is signed in: a JWT verified by signature against the Better Auth tool's JWKS (issuer, audience, JWKS address and the account claim are DATA) |
| `rows.rs`, `rows/` | The account's own rows that are not records (computers rows, lists), the rows a new account starts with (`StartingRows`: copies row and copy rules row) |
| `account_routes.rs`, `account_routes/` | The account door: admits each call by the signed-in JWT (`signed_in.rs`) naming this account's address, and answers its own `@sign-in` operations (computers row and list, limits row, copy rule rows, deletion), named as DATA in `account_routes/door-operations.json` |
| `create.rs` | Making an account and writing its starting rows |
| `erase.rs`, `erase/` | Deleting the account completely when its person asks (`sign-in:delete-account`): one kept deletion, bounded steps over its tool runs, files, records and its own rows that resume where they stopped |
| `computers.rs`, `computers/` | Computers rows, copies, writer row, the copy rule |
| `person_present.rs` | Which writes need the person present: a caller whose own sign-in pass is within Better Auth's fresh-session age |
| `devices.rs` | Devices |

Account values are rows in the account's own lists (`docs/placement-decision/stage-3-lists.md`), never files.

`create.rs` also owns the schemas of the stores the account's routes open besides its records, vault and its own rows
(`AccountStores`, `read_account_stores`, `write_account_stores`, `write_ready_records`): a computer that joins an account
by itself makes them from another computer's rows (`src/native_entry/computer/join_itself.rs`).
