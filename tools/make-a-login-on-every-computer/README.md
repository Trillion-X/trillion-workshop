# tools/make-a-login-on-every-computer/

Makes this computer's own database login for one pursuit, held in this computer's vault, and gives it its grants. Each computer runs it for itself. A single generated value cannot be put to two vaults (a vault's `make` runs in that vault alone, and no bytes move between computers), so the login is one per computer: its own password, its own role, and its own held value.

| File | Purpose |
|------|---------|
| `do-work/make-a-login.mjs` | The run: reads the input JSON on stdin, checks this computer's held value (or puts it), reads the name back, makes this computer's role with the `a-login` recipe, and gives its grants. |
| `test/make-a-login.test.mjs` | 9 tests against a stub door: the order of calls, no call names another computer, the password absent from the answer and from every tool run, a refused put and a missing read-back each stop before any role is made, a re-run resumes at the grants when the role exists, `make_role` false makes no role, a `held_name` is used exactly in place of the default name, and bad input is refused before any put. |
| `tool-rows.json` | The Workshop row (`tool:make-a-login-on-every-computer`), with the `secrets:put` rights block for the three pursuits' connection names (pattern rights; owner connections fall outside them). |

## Input

`login`, `database`, `host`, `computer` (this computer's short name, carried in the role name `<login>_<computer>`), `operator` (required when `make_role` is true), `grants` (optional `{recipe}`), `make_role` (default true), `held_name` (optional: the vault name to hold it under in place of `<login>-connection`, for a reader that asks for a set name, such as the engine's `<database>-writer-connection` writer login; it ends in `-connection`).

## Order

1. Check whether this computer's role exists. If it does, the held value must already be on this computer (a missing one needs a password reset, which this tool does not do); otherwise put the value to this computer's vault.
2. Read the name back on this computer. A missing name stops the run.
3. When `make_role` is true and the role is new, run `a-login` on this computer, then the `grants` recipe as the database's owner.

Nothing here prints or stores the password. Each error is scrubbed of it before it leaves the process.
