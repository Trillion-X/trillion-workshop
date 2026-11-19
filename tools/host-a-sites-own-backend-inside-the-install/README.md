# tools/host-a-sites-own-backend-inside-the-install/

Host a site's own backend inside Trillion: install its code, give it a private database and serve its files.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Serving a site's Worker bundle on a computer (Nov 19 2026)

| File | What it does |
|---|---|
| `do-work/serve-a-site-worker.mjs` | The program a computer row's unit runs for one site: it imports the site's Worker bundle (`wrangler deploy --dry-run --outdir`) unchanged except its one `cloudflare:workers` import, serves the site's built files first the way Workers assets do (auto-trailing-slash, `_headers`, `run_worker_first`), sends every other request to the Worker's `fetch`, answers `/readyz` for a slot switch and drains on SIGTERM. Settings: `SITE_BUNDLE`, `SITE_FILES`, `SITE_SETTINGS` ({vars, run_worker_first, email_account, kv_table}), `PORT`; held values from the unit's credentials folder: `site-database`, `email-sending-token`, and each of the Worker's secrets as its own file, named as the secret in lowercase with `-` (`mail-link-key` is `env.MAIL_LINK_KEY`). |
| `read-data/workers-stand-ins.mjs` | The Workers runtime the bundle reads: HTMLRewriter (lol-html through html-rewriter-wasm), D1 as Postgres, KV as a table, Email Sending over HTTP, `caches.default` in memory, `WorkerEntrypoint`. |
| `test/workers-stand-ins.test.mjs` | Each stand-in answers as the Workers API does (6 tests). |

Why not the files in `from-an-older-version/`: they load a site's Worker inside a Worker Loader isolate of one Workers host that holds every site, with an RPC database. A site now runs on a computer its owner chooses, and no shared host keeps anyone's sites or storage, so the host is a plain program there. Their source checks (`site-worker-source.mjs`) import the older version's public-app file store and stay held.
