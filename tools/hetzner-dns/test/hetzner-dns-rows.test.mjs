// The Hetzner DNS rows promise: every row that holds the key sends it only to api.hetzner.cloud, in the Authorization header, and names no person or token value.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const rows = JSON.parse(readFileSync(new URL("../tool-rows.json", import.meta.url), "utf8"));

test("every Hetzner DNS row holds only the hetzner-api-token, sent to api.hetzner.cloud as a bearer header", () => {
  assert.ok(rows.records.length > 0);
  for (const record of rows.records) {
    const invoke = record.payload.invoke;
    assert.equal(invoke.kind, "http");
    assert.ok(invoke.url.startsWith("https://api.hetzner.cloud/v1/zones"), record.payload.id);
    assert.equal(invoke.credential_injections.length, 1, record.payload.id);
    for (const injection of invoke.credential_injections) {
      assert.equal(injection.secret_name, "hetzner-api-token");
      assert.deepEqual(injection.hosts, ["api.hetzner.cloud"]);
      assert.equal(injection.placement.name, "Authorization");
      assert.equal(injection.placement.prefix, "Bearer ");
    }
  }
});

test("only the list and read rows are read-only; the zone-create, record and delete rows are not", () => {
  const readOnly = rows.records.filter(record => record.payload.read_only).map(record => record.payload.id).sort();
  assert.deepEqual(readOnly, ["tool:list-hetzner-dns-zones", "tool:read-hetzner-dns-rrsets"]);
});

test("the create-zone row makes a primary zone with a 60-second TTL", () => {
  const create = rows.records.find(record => record.payload.id === "tool:create-a-hetzner-dns-zone");
  assert.equal(create.payload.invoke.method, "POST");
  assert.equal(create.payload.invoke.url, "https://api.hetzner.cloud/v1/zones");
  assert.deepEqual(create.payload.invoke.body.mode, { const: "primary" });
  assert.deepEqual(create.payload.invoke.body.ttl, { const: 60 });
});
