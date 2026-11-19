# tools/run-tools-in-my-signed-in-browser/

Lets a tool run on the person's own computer read a page, act on one and drive a session in the browser the person is signed in to. A browser cannot be driven through its debugging port: Chrome 136 and later ignore `--remote-debugging-port` on the default profile, the one the person is signed in on ([Chrome for Developers, Changes to remote debugging switches](https://developer.chrome.com/blog/remote-debugging-port)). So the browser extension holds a native messaging connection to the host this computer places, the host opens a loopback door while that connection is open, and three tool rows reach the door as a computer tool reaches a local server.

## Files

| File | Purpose |
|------|---------|
| `browser-relay.mjs`, `browser-relay.json` | The door. While the connection is open the host listens on loopback `host`:`port` (DATA; port name `browser-relay`). `POST challenge_path` gives a single-use nonce; `POST path { tool, input, request_key, nonce, signature }` passes the request to the extension and returns its answer. Bounded by `most_request_bytes`, `most_answer_bytes`, `most_waiting` and `most_seconds`. Refuses, in `words`, a request with an Origin, another Host, a body that is not application/json, a tool not listed, or no good proof. With no browser connected the caller is told so. One browser holds the door at a time. |
| `ask-my-browser.mjs` | The command the three rows run: asks the door for a nonce, has the run's own vault door sign it (`secrets:sign`, the row's one right), posts the request and prints `{ result }` or `{ error }`. |
| `computer-relay.mjs` | For the extension: holds one `chrome.runtime.connectNative` connection while the person has allowed the computer, asks the host for the door (`relay_open`), answers each request with the function the extension gives and sends it back with the same `request_key`. Retried on an alarm (`check_every_minutes`). `startComputerRelay` is what the extension calls. |
| `tool-rows.json` | The rows `tool:read-a-page-in-my-browser`, `tool:act-in-my-browser` and `tool:drive-my-browser`. Each lists the local door `browser-relay` and the one vault right it needs. |
| `kits/` | One kit per tool. |
| `test/browser-relay.test.mjs` | The door, the proof, the limits and the extension's side, on a real loopback port with a fake extension. The host's framing is tested beside the host. |

## Who may ask

A run proves it was started by the engine for this person. The person's vault holds an Ed25519 key `browser-relay-key` (made once by the shared workflow `make-a-signing-key-in-the-vault`; the private half never leaves the vault); the host asks the vault for its public half (`secrets:public`) each time it opens the door, so a new key takes effect on the next connection and no copy is kept in a file. A run signs `<nonce>\n<tool>\n<input as JSON>` through `secrets:sign`; the door checks it, spends the nonce whether or not the proof was good, and tells the extension nothing of a request without a good proof. With no such key in the vault the door does not open, and says so in words. A web page cannot reach it either (no Origin, the Host is checked, the body must be JSON).

## Applied by the computer's owner, from its row

- The computer's report names the port: `local_ports` gains `"browser-relay": <number>`. That report is the number's one home. The rows are given it with `{"fill": {"from": "computer", "field": "local_ports.browser-relay"}}` as the last word of their command, and the host reads the same name from the report the Mac app renders (`native-host/offer-in-browsers.json` `engine_door.computer_report`). A computer that reports no such port opens no door and every run is refused in the `no_port` words.
- The vault key above is made by the workflow `make-a-signing-key-in-the-vault`.

## Not proven

A run with a real browser, its real extension and a computer that reports the port. Chrome and Brave open together: the first holds the door.
