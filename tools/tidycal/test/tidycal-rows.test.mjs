// The TidyCal rows promise: every row that holds the key sends it only to tidycal.com, in the Authorization header, and names no person or token value.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const rows = JSON.parse(readFileSync(new URL("../tool-rows.json", import.meta.url), "utf8"));

test("every TidyCal row holds only the tidycal-api-token, sent to tidycal.com as a bearer header", () => {
  assert.ok(rows.records.length > 0);
  for (const record of rows.records) {
    const invoke = record.payload.invoke;
    assert.equal(invoke.kind, "http");
    assert.ok(invoke.url.startsWith("https://tidycal.com/"), record.payload.id);
    for (const injection of invoke.credential_injections) {
      assert.equal(injection.secret_name, "tidycal-api-token");
      assert.deepEqual(injection.hosts, ["tidycal.com"]);
      assert.equal(injection.placement.name, "Authorization");
      assert.equal(injection.placement.prefix, "Bearer ");
    }
  }
});
