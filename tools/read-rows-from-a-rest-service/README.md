# Read rows from a REST database service

One container tool, `tool:read-rows-from-a-rest-service`: reads the rows of one table of a PostgREST service the person connected (the Supabase descriptor is in `tools/connect-a-service-and-seal-its-key/records.json`). The service key reaches the run on a private pipe (descriptor 3). The project URL is a request field (it is not a secret), and the key goes only to a project under a domain `read-data/hosts.json` names (`supabase.co`; another service is one more row), at that project's `/rest/v1` path, as the `apikey` and `Authorization: Bearer` headers.

`read-data/hosts.json` is the domain list. `do-work/read-rows.mjs` holds `projectOrigin`, `filterPairs` and `readRows`. It issues GET requests only, with the select, filters, order, limit and offset the input names.

Run the focused check from the repository root:

```
node --test tools/read-rows-from-a-rest-service/test/read-rows.test.mjs
```

The test is synthetic: a made-up project URL and rows. It does not show that a live project answers. That needs the person's connected project and the tool run through the door.
