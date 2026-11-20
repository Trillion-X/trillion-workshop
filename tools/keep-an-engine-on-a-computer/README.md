# Keep an engine on a computer

What a computer row names to run the engine (trillion-rust `src/native_entry/computer.rs`): its unit template and the web server's route to it. start-a-computer knows no program. It builds the engine from the row's `source` commit on the computer itself, and runs it in slots so a deploy drops nothing. These files came out of start-a-computer and the Caddy kit on Nov 18 2026 (K5 of the plan that no general tool knows a program).

- `serve-computer.service` is the engine unit's template. It runs `{builds}/{current}/{program} serve {settings_file}` as the unit's user. A stop asks the engine alone to finish what it holds, within `stop_seconds`, and the tool runs it started keep running (`KillMode=mixed`). The row names it as `template: tools/keep-an-engine-on-a-computer/serve-computer.service`.
- `serve-computer-key-sealed.service` is the same unit with the computer key kept sealed by systemd and handed to the engine on descriptor 4, so no file holds it (a unit names `key_sealed_file`; see start-a-computer's README, "A computer key kept sealed"). Its other lines are those of `serve-computer.service`.
- `caddy-route-engine.caddy` sends a site's `engine_paths` to the pool `engine`, which holds every slot of the engine. The first slot that answers its health page takes each call. A site names it in `engine_routes`.
