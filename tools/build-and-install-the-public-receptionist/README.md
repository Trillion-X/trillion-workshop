# tools/build-and-install-the-public-receptionist/

Builds and installs the public receptionist on its own rented Linux host from one committed Rust source tree. This tool does not change the application. It archives the selected commit, builds the caller's requested executable target, then checks and installs the built artifact.

## Rows

| Row | Operation | What it does |
|-----|-----------|--------------|
| `tool:prepare-a-receptionist-build-host` | `prepare` | Installs the given build packages, makes `source_root`, adds the given swap file if it is missing, and installs the exact Rust toolchain given. The script goes to the host on standard input. |
| `tool:read-a-receptionist-build-host` | `inspect` | Reads the kernel, the Rust version, memory, compilers that are running, source folders and built receptionists, listeners on the given ports, and the given service user's sign-ins. Changes nothing. |
| `tool:build-the-public-receptionist` | `build` | Runs `git archive` on one commit of a local Rust source checkout and sends the archive to the host. On the host it builds the requested executable target under `source_root/<commit>` and runs its bootstrap-credential test. |
| `tool:install-the-built-receptionist` | `install` | Checks that the built file from the given commit is on the host and makes it runnable. When `install_path` is given, it also puts a copy there, swapped in with one rename. |

## Inputs, not code

The host is `{ address, ssh_port, admin_user, host_key }`. Every host path (`source_root`, `swap.path`, `rust.cargo_home`, `rust.rustup_home`, `install_path`), every port, every user, the Rust version (`rust.toolchain`, an exact `x.y.z`) and the executable target (`binary`) are declared fields in the rows' `input_schema`. The caller supplies `binary` from product data; this tool has no product-specific default. Names must be one safe executable name, not a path. The target and its test `bootstrap_consumes_and_closes_the_original_credential_descriptor` are passed to Cargo.

## Keys and what travels

- The host administration key is the person's held value `rented-host-admin-ssh-key`. The engine mounts it as a private file (`credential_mounts` `mount_path`), and only `ssh -i` reads it.
- The host key is pinned from the input. A new host key is never accepted.
- The SSH arguments come from the library `tools/administer-a-rented-host`. These rows pack that library; they don't copy it.
- `git archive` sends committed source only. No home folder, Git configuration, uncommitted file, credential or account database travels.

## Answers

Every run prints `{ result }` or, on a refusal, `{ error }`, as its last line. A refusal names the field and how to fix it. `"dry_run": true` returns the `ssh` arguments and the remote command and runs nothing; each row's sample is a dry run. A dry run of `build` reads no repository, so it needs the full commit as `revision`.

Tests: `node --test tools/build-and-install-the-public-receptionist/test/`. ssh is a stand-in there, git runs for real on a throwaway repository, and every host is synthetic (192.0.2.x, example.com).
