# tools/make-a-login-on-every-computer/

Makes one database login that every computer the person names holds under one name, and gives it its grants. It is the one path that puts a generated password on more than one computer: the password is made once, in this process, and put to each computer's vault through the engine's `secrets:put` (the person's own key, as `tool:keep-a-secret-by-name` does). A single make in the vault generates a different value per computer, so it cannot fan out.

| File | Purpose |
|------|---------|
| `do-work/make-a-login.mjs` | The run: reads the input JSON on stdin, puts the value to every pin, reads the name back on every pin, then (when `make_role` is true) makes the role with the `a-login` recipe on the always-on computer and gives its grants as the database's owner. |
| `test/make-a-login.test.mjs` | 6 tests against a stub door: the order of calls, the same value on every pin, the value absent from the answer, from every error and from every tool run, a refused put and a missing read-back each stop before any role is made, `make_role` false makes no role, and bad input is refused before any put. |
| `tool-rows.json` | The Workshop row (`tool:make-a-login-on-every-computer`). |

## Input

`login`, `database`, `host`, `pins`, `always_on` (must be one of `pins`), `operator` (required when `make_role` is true), `grants` (optional `{recipe}`), `make_role` (default true).

## The pin list

`pins` comes from the input for now. The person's computers have no rows yet: the computer table holds only server rows, and the Mac has none (finding `record:calendar-task:mac-has-no-computer-row-2026-11-21`). Once every computer has its row, the list is read from the rows, and this input is then only a check.

## Order

1. Put the value to every pin. A refused put stops the run and names the pin.
2. Read the name back on every pin. A missing name stops the run and names the pin.
3. Only then, when `make_role` is true, run `tool:run-sql-in-my-database` with `a-login` on the always-on computer, then the `grants` recipe as the database's owner.

Nothing here prints or stores the password. Each error is scrubbed of it before it leaves the process.
