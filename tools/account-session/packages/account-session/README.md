# Account Session Package

Generic browser account-session source package. The package owns browser-session
read/write targets, returning-login completion helpers, and the compact account
login surface. External identity providers must prove an account before calling
`account-session.start-verified-browser-session`; invented account data is fake
auth and is not an accepted proof path.

`account-session.authorize-transient-session` translates generic shell handshake
evidence into a fail-closed transient-session authority reply. It reads only the
configured account-session cookie, verifies the existing signed token, and
returns the canonical account principal plus a deterministic hash reference for
the session token. It accepts canonical `{cookie_header, header_map}` evidence
and the shell interoperability shape `{headers:[{name,value}]}`; conflicting
representations fail closed. It never returns the raw token, denial reasons,
scope policy, reply aliases, or an inferred display identity.

Live proof still goes through log-owned package admission and app-open
target evidence. This source folder is implementation/proposal material.

## Current Identity Boundary

Returning-login work invokes `account-identity.derive` and reads the returned
role-addressed identity rows. Account-session translates those required role
values into its own login proof payload, but it does not require account-identity
to return a fixed owner DTO.
