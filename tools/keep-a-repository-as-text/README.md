# tools/keep-a-repository-as-text/

Pulls one outside git repository onto the person's computer as ONE text bundle, so an AI can read the whole repository in one file. The repository is only data: nothing in it is run, installed, built, imported or sourced.

- `keep-a-repository-as-text.mjs`: the command. It reads one JSON input on standard input and prints one JSON line. It also exports the steps (`checkInput`, `cloneShallow`, `listFiles`, `licenceOf`, `readFilesForBundle`, `bundleText`, `pullAndBundle`).
- `read-data/limits.json`: the DATA. The default root for future pulls (`~/Library/Application Support/pulled-files/repos`), the per-file cap, the total cap on file contents, the binary sniff size, the time limits, and the licence phrases that name MIT, Apache-2.0 and GPL-3.0-only from a licence file.
- `tool-rows.json`: the Workshop row for `tool:keep-a-repository-as-text`.
- `test/keep-a-repository-as-text.test.mjs`: unit tests on a fixture repository made in a temp folder, including equal bundle bytes and BLAKE3 on repeat pulls, and one live test on https://github.com/TheMattBerman/ad-spy-kit.
- `kits/keep-a-repository-as-text.json`: the instructions and worked example; marked draft until a real run through the installed Workshop row is observed.

The bundle is named `<owner>__<repo>@<commit>.txt` for GitHub, and `<host>__<owner>__<repo>@<commit>.txt` for other hosts. Its identity is the content-identity owner's `1f:<64 hex>` form (`tools/content-identity/read-data/identity.mjs`), not a bare SHA-256.

How git is kept from running the repository's code: `git init --template=` makes an empty repository, `core.hooksPath=/dev/null` turns hooks off, global and system git config are pointed at nothing, LFS smudge and filters are off, and only the newest commit (depth 1) is fetched. Submodules are not fetched.

Run local tests: `node --test tools/keep-a-repository-as-text/test/keep-a-repository-as-text.test.mjs`. The live test is skipped unless explicitly enabled. Local tests need no network access and do not change saved repository bundles.

When network access is authorized, run the live test with `REPOSITORY_TEXT_LIVE_TEST=1 node --test tools/keep-a-repository-as-text/test/keep-a-repository-as-text.test.mjs`. It needs github.com and api.github.com, writes only in its own test folder, and removes that folder when finished. It does not write in the DATA root.

The header contains no timestamp. With the same URL, commit, licence information and limits, repeat pulls produce the same bundle bytes and BLAKE3. Changing the DATA root affects future pulls only; existing bundles are not moved or rewritten.

Not proven: a repository that uses git features beyond plain files (LFS objects, sparse or partial clones, very deep histories); a licence file that is not one of the three phrases in `limits.json` (it is reported as present but not identified); the install of this folder on the person's computer through its row (a keeper's job, not this folder's).
