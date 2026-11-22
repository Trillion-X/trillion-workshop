// The Stripe account row promises: it sends the key its caller names (key_name) to api.stripe.com as a bearer header, and it only reads.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const rows = JSON.parse(readFileSync(new URL("../tool-rows.json", import.meta.url), "utf8"));

test("the Stripe account row is one GET to api.stripe.com that takes its key name from input", () => {
  assert.equal(rows.records.length, 1);
  for (const record of rows.records) {
    const invoke = record.payload.invoke;
    assert.equal(invoke.kind, "http");
    assert.equal(invoke.method, "GET");
    assert.equal(invoke.url, "https://api.stripe.com/v1/account");
    assert.equal(record.payload.read_only, true);
    assert.deepEqual(record.payload.input_schema.required, ["key_name"]);
    assert.equal(invoke.credential_injections.length, 1);
    for (const injection of invoke.credential_injections) {
      assert.equal(injection.secret_name_from_input, "key_name");
      assert.equal(injection.secret_name, undefined);
      assert.deepEqual(injection.hosts, ["api.stripe.com"]);
      assert.equal(injection.placement.name, "Authorization");
      assert.equal(injection.placement.prefix, "Bearer ");
    }
  }
});
