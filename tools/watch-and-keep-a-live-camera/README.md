# parts/receive-a-camera-stream/

Lets a camera that streams live (RTMP or RTMPS, such as a mirrorless camera set up from its phone app) send to one address that never changes, and lets the person choose where the stream goes behind that address from their own rows: into their Trillion files in pieces that are clipped as they arrive, passed on to another service, or any kind added later. A camera's destination is set from its phone app, and the camera holds one address. So switching happens on the computer that takes the stream, by changing one cell on the camera's row.

Where the stream goes is the person's DATA, four lists in their account (`stream-settings.json` `lists`):

| List | Rows | The cell that matters |
|------|------|------------------------|
| Stream kinds (`stream-kinds`) | What each way in and each destination does | Capability: the carried module that does it |
| Stream ways in (`stream-ways-in`) | The one address a camera is set to, and how it reaches this computer (from anywhere through Tailscale Funnel, same Wi-Fi, home router) | Server address for the camera (written by the computer) |
| Stream destinations (`stream-destinations`) | Where a stream goes: the person's files through this computer, another service's ingest address | Turned on |
| Camera streams (`camera-streams`) | Each camera: its way in, its destination | Destination (one cell); Automatic (first ready) when filled |

A new kind of way in or destination is a row in Stream kinds plus a module in `do-work/capabilities/` named by its Capability cell. The program never names a kind.

## Files

| File | Purpose |
|------|---------|
| `do-work/receive-a-camera-stream.mjs` | The program the Trillion Mac app runs as its child (`macos/computer-reader.json`, `camera-stream-receiver`). It keeps the lists and the starting rows this computer can serve (each only when missing). It reads the cameras list every `read_rows_every_seconds.cameras` and the others every `.all`, and for each camera it takes it opens its way in, picks its destination and runs that kind's capability, writing each row's Now cell. It also makes each camera's stream key (keychain plus Saved logins), and takes over from a receiver set up by hand. |
| `do-work/take-a-stream.mjs` | The listener every destination shares: FFmpeg waits for one camera's RTMP stream on its port and writes it out as the capability says. A stream sent with another key is cut off at once (FFmpeg's own listener only logs it). |
| `do-work/capabilities/file-pieces-into-trillion.mjs` | Destination: cuts the stream into fragmented MP4 pieces and sends each into the namespace while it is written (`growingFileSource` + `sendFile`), under `/Recordings/Cameras/<day>/`, where `starting:transcribe-video` hears it whole and hands it on. Ledger `sent.jsonl`; a piece is deleted here only once the namespace holds it. |
| `do-work/capabilities/relay-to-an-address.mjs` | Destination: passes the stream on unchanged to the row's address with the key read from the saved login the row names. |
| `do-work/capabilities/public-address-through-tailscale-funnel.mjs` | Way in: a public RTMPS address (`rtmps://<computer>.<tailnet>.ts.net:<port>/live`) through Tailscale Funnel's TLS-terminated TCP. It reaches this computer from any network for free, is set again whenever it goes missing, and never takes a public port that already serves something else. |
| `do-work/capabilities/this-network.mjs` | Way in: this computer's address on its own network. |
| `do-work/capabilities/router-port-forward.mjs` | Way in: the home network's public address, for a router that forwards the port here. |
| `RTMPcert.pem` | Camera-ready PEM trust anchor for the current Let's Encrypt YE1/Root YE public RTMPS chain; Sony imports this exact filename for Streaming. |
| `stream-settings.json` | DATA: service, the four lists and their starting rows, listener port and app, key rules, FFmpeg and Tailscale search paths, piece length and names, retry waits, stay-awake command, hand-made receivers to take over, every word a row shows. |
| `part.json` | The part's public files. |
| `README.md` | This file. |

## Camera trust for the public RTMPS address

The public Tailscale Funnel address is secure RTMPS. Some embedded cameras do not yet trust a newly introduced public root even when newer computers do. This part therefore carries a versioned, camera-ready trust package instead of weakening the endpoint to plain RTMP:

- `RTMPcert.pem` is the self-signed ISRG Root YE certificate published by Let's Encrypt. Its SHA-256 fingerprint is `E1:4F:FC:AD:5B:00:25:73:10:06:CA:A4:3A:12:1A:22:D8:E9:70:0F:4F:B9:CF:85:2F:02:A7:08:AA:5D:56:66`.
- Use it only after the current endpoint chain has been read and shows the Let's Encrypt YE1 / Root YE family. A future certificate renewal can change the needed anchor.
- A Sony α7 IV on firmware 3.00 or later imports the streaming root from a file named `RTMPcert.pem` at the root of a Slot 1 memory card: **MENU → Network → Network Option → Import Root Certificate → Streaming → OK**.
- Keep the stream URL as `rtmps://`. Plain `rtmp://` sent to a TLS-terminated Funnel port is not a compatibility fallback.
- Importing a certificate is preparation, not outcome proof. Completion is a camera-origin piece independently read from `/Recordings/Cameras/<day>/`.

Certificate source: [Let's Encrypt Root YE](https://letsencrypt.org/certs/gen-y/root-ye.pem). Camera procedure: [Sony α7 IV Import Root Certificate](https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000653555.html).

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `chooseDestination` | `(camera, destinations: Map, ready: Map) → row \| null` | The Destination cell's row when turned on, or the first turned-on, ready row of Automatic when that is filled. |
| `keepTheLists` | `({ settings, call, names, capabilityOf, ctx }) → rows` | The four lists and starting rows, each only when missing; a way in or destination only when its capability is available here. |
| `followTheRows` | `({ settings, ctx, call, names, capabilityOf, keyStore? }) → { round(), stop() }` | One round makes this computer match the rows. |
| `capabilities` | `(settings) → name → module \| null` | A carried module named by a Capability cell; nothing else. |
| capability (destination) | `{ available(ctx), ready({ ctx, row }), start({ ctx, camera, row, port, key, onState }) → { stop() } }` | One kind of destination. |
| capability (way in) | `{ available(ctx), open({ ctx, port }) → { address, protocol, state, close() } }` | One kind of way in. |

**Depends on:** FFmpeg on the computer (`ffmpeg.search_path`), Tailscale for the anywhere way in, `../live-namespace/do-work` (sender, client, chunking), `../receive-files-over-ftp/do-work` (`keychain.mjs`, `accountTools`, `localAddress`), `../../computer/end-with-the-app.mjs`, the account's list and saved-login tools over `/mcp`.
**Depended on by:** `macos/computer-reader.json` (`camera-stream-receiver`), `test/receive-a-camera-stream.test.mjs`.
