# Sign-in rows

One account's sign-in database (`families.json`, schema `sign_in`): clients, grants, tokens, requests, passkeys and
challenges, sessions, personal keys, the other ways in, the computers rows (`places`) and the account's own lists
(`lists`). The `lists` family holds the account's sign-in settings row (`lists.rs`), its ways row (`ways.rs`), its words row
(`words_row.rs`: every word its sign-in pages, ways and operations say; no word is in a file here), and its
copy rule's rows and runs (`../computers/copy_rule.rs`). Every row names its account; secrets are kept only as hashes.
