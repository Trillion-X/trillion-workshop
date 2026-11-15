# Native entry

How the engine starts.

| File | What it does |
| --- | --- |
| `../native_entry.rs` | The Mac app's entry (`native-serve DESCRIPTOR`): the selected account behind its parent pipe |
| `computer.rs`, `computer/` | A computer's entry (`serve COMPUTER_CONFIG`): one config file, the accounts folder it names, its forwarder sessions, the signed release feed it follows, and the copy rule's hourly sweep of every account it holds (`keep_copy_rule_sweep`, src/account/computers/copy_rule.rs) ([its parts](computer/README.md)) |
| `live.rs`, `workspace-live.json` | The live workspace stream |
| `preparation_gate.rs` | The startup preparation gate |
