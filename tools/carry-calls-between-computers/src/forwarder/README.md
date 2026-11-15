# Mac-initiated forwarder connection

`session.rs` implements bounded request/reply framing for a confidential stream
created by the Mac. `ConnectionAdmission` supplies the current device/route
authority. `ForwarderConnection` admits the private credential, remains unavailable
until the routing owner acknowledges installation, and retires ambiguous I/O.
`connect_mac_session` consumes that acknowledgement before Mac dispatch begins.
It rechecks the acknowledgement's expiry before each message is dispatched and
before a reply is returned; an expired session must reconnect.

`connected_computers.rs` is the per-process route directory and connection for admitted
sessions. It installs a session before acknowledging it, keeps account/resource
slots separate, retires a replaced connection, and stops advertising a route
after registration revocation or transport retirement. A failed acknowledgement
restores the previous ready session. The list of connected computers is gone on process restart;
the public hosting owner still has to provide stable address routing and
confidential transport to the same instance.
When its 4,096 route slots are full, it reclaims expired sessions and empty
slots no admission still holds. An in-progress installation keeps its slot.

`gateway.rs` composes that owner of the connected computers with the authenticated MCP HTTP
adapter. Its constructor requires bearer authentication, exact client-proof
issuance, current device-registration admission, a public Host and a trusted
clock. The caller supplies the actual TLS-terminated HTTP listener and the
Mac's confidential, deadline-bound stream. It cannot serve a public address
without those owners and does not create a substitute account authority.

`Gateway::http_route_table` is the forwarder's whole HTTP route table: MCP, and every
path that names an account (`/a/<address>/...` and the discovery paths with
`/a/<address>`). Such a request goes whole, as one `places:http` message, to the
session of a live computer that answers the account (the writer first), and the
computer's answer is the answer. `POST /a/<address>/computers/<to>` with a computer's own
`trp_` proof is a message from one computer of the account to another
(`account/computers/messages.rs`); it goes as one `places:relay` message on the session
of computer `to`. The list of connected computers remembers, in memory, the newest writer term it carried
for an account and refuses a writer's message below it (`term_check`: `TermCheck::Stale` below the newest term, `Lapsed` once its term ran out).
A path that names no account is 404 `no_account`: the forwarder answers no sign-in, sign-up or OAuth path of its own.
`answers.rs` holds the two HTTP pieces the forwarder and the computer read alike: which account a path names
(`named_path`) and a JSON answer whose refusal names its cause (`json`).

The bearer check is the one signed-in check (`src/account/signed_in.rs`): a bearer is a JWT the sign-in tool (Better
Auth, run as a Workshop tool) signed, checked by its signature against that tool's JWKS with its issuer, audience and
times, and its account claim names the account. No computer is asked who a caller is, so a check costs no round trip;
the computer that answers the account admits the same credential again for every operation. A token that does not
check is 401; a JWKS that cannot be read is 503 and never admits. With a door origin (`Gateway::with_door`) the MCP
resource's RFC 9728 discovery names that origin as its authorization server; without one, a refused credential hears
the plain `Bearer` challenge. When the hosting owner names a root account (`TRILLION_MCP_ROOT_ACCOUNT`,
`Gateway::with_root_account`), the account routes that name no account in their path (`origins.json`
`root_account_paths`) go to that account's live computer. The person, Nov 13 2026: sign-in is Better Auth, self-run, as a
Workshop tool; the engine only verifies.

`origins.rs` answers another browser origin with the installation of the account that signed it: a
computer hands in the account's signed origins row (`POST /a/<address>/places/origins`), kept in memory
while a computer of the account is live and for `name_hold_ms` after; a `<name>.trillion.run` name is held
by the first live account (reserved and code-shaped names by nobody), a person's own domain needs its
`_trillion-verify` TXT proof, read by `origin_dns.rs` (hickory-resolver, plain DNS to the system's resolvers, UDP then TCP)
in production; a renamed host (`moved_to`) sends a page read on with 301; `/origins/certificate?domain=`
answers an on-demand TLS terminator in front (200 only for a host one live account names). See
docs/sites-port.md.

`websocket.rs` upgrades either side of a caller-supplied verified TLS stream
and adapts the WebSocket to the session byte stream. The Mac calls
`upgrade_resource_websocket_on_verified_tls` before `connect_mac_session`;
the gateway calls `accept_resource_websocket` before device admission.
Each message is binary and contains exactly one four-byte big-endian length
followed by a nonempty payload of at most 65,536 bytes. The adapter bounds
incoming WebSocket frames and messages, refuses text and malformed lengths,
and sends one message per flushed session message. The Mac and public listener
must both use this wire format. Their callers still own TLS establishment and
verification, stream deadlines, and the actual connection endpoint. The
focused test uses loopback plaintext WebSocket; it proves wire
interoperability through the local MCP gateway and SQLite, not public WSS.

`Gateway::admit_mac_websocket` composes the exact upgrade gate with registration
and admission to the connected computers. It accepts only the configured Host and
`/mcp/resource-connection` path with no query, Origin, subprotocol, extension
or absolute-form request target. The listener must supply an authenticated,
confidential TLS stream before this call; the gate does not create TLS.
Both the WebSocket and raw stream admission calls reserve one of 32 pending
slots before reading handshake or credential bytes, and release it on every
outcome. A hosting listener must also bound accepted sockets and worker threads
before calling either method; this in-process cap does not provide that bound.

`ingress.rs` is the door's listener: plain HTTP on the loopback address the hosting owner gives
(`TRILLION_MCP_LISTEN`), served by axum over hyper. The front door in front of it (Workshop tool
start-a-computer, a layout's `caddy` row with `front_door`) holds TLS and its certificates, makes one on demand
only when `/origins/certificate` answers 200, and carries every request here with its own Host. It serves the
Gateway's route table behind a Host gate (the door's own Host, or another origin a live account names; anything
else 421) and the Mac's `GET /mcp/resource-connection`: the exact upgrade gate (`websocket::upgrade_admissible`),
then hyper's own upgrade, carried to the blocking session as `UpgradedStream`, whose reads wait 5 s (the longest
message deadline once the session is admitted) and whose writes wait 5 s, all within the connection's deadline.
At most 64 requests run at once (one more is answered 503) and each is answered within two minutes. It parses no
HTTP and holds no key; tests put a TLS front door of their own in front of it (tests/support/front_door.rs).

The connection uses `ComputerConnections` from its parent module and operation messages
from `resource_authority`. It does not supply TLS, account registration,
production credentials, the public endpoint or an installed Mac host.

A message from one computer of an account to another (`places:relay`) reaches a
computer the account's newest believed row names even when that computer holds
no session telling the account yet: it goes on the computer's own session
(`session::computer_wide`, `ConnectedComputers::computer_route`), and the computer
then starts holding the account by itself (src/native_entry/computer/join_itself.rs).
The account's calls never go this way: `current_route` reads only sessions that
told the account.
