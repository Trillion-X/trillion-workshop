# Keep an Elestio firewall

`tool:keep-an-elestio-firewall` makes the firewall of one Elestio service equal a rule set its owner keeps as DATA (a computer's row), and reads it back. It holds no rules itself.

Why: on Nov 25 2026 two Elestio computers were found with their firewall off and nothing owning it, so anything that listened on every address was open to everyone.

## What it does

| Step | How |
|------|-----|
| Session | `auth/checkAPIToken` with the account email and the held `elestio-api-key` (fd 4). |
| Read | `servers/getServerDetails` (`isFirewallActivated`), and when on, `servers/DoActionOnServer` action `getFirewallRules`. |
| Compare | As sets of type, port, protocol and sorted targets. |
| Send | Off: `enableFirewall` with the rules. On and different: `updateFirewall` with the rules. Both replace every rule, so a dashboard tool's port (Tail Logs 18445, VS Code 18345, Terminal 18344, File Explorer 18346, Open Terminal 18374) is closed unless the rules name it. |
| Read back | Every `poll_seconds` until on with exactly the rules, or `wait_seconds` (300). |
| `apply: false` | Reads and answers the difference; sends nothing. |

It refuses, before any call, a rule set without 22/tcp and 4242/udp open to `0.0.0.0/0` and `::/0`: Elestio's automation SSH and its Nebula private network, which Elestio's own tools require exactly so. So the tool cannot cut Elestio off from the computer. The way back from a wrong set is this tool with a corrected set, or Elestio's `disableFirewall`.

Holding a key, it reaches only `api.elest.io`, so it cannot test the ports: check from outside, in a step without a key, that the kept ports answer and the rest refuse.

## Source and checks

`do-work/keep-an-elestio-firewall.mjs` (Node's own `fetch`; no package). `test/keep-an-elestio-firewall.test.mjs` answers each call with a made-up service: switched on from off, replaced when different (closing a tool port), left alone when equal in another order and spelling, `apply: false`, a slow apply and one that never applies, the Elestio ports refused when missing or narrowed, bad shapes, an empty token, and a refusal with key-like words masked. Run `node --test tools/keep-an-elestio-firewall/test/keep-an-elestio-firewall.test.mjs`.
