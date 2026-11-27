// The TidyCal rows promise: every row that holds the key sends it only to tidycal.com, in the Authorization header, and names no person or token value.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const rows = JSON.parse(readFileSync(new URL("../what-this-tool-does-and-how-to-run-it.json", import.meta.url), "utf8"));

test("every TidyCal row holds only the tidycal-api-token, sent to tidycal.com as a bearer header", () => {
  assert.ok(rows.records.length > 0);
  for (const record of rows.records) {
    const invoke = record.payload.invoke;
    assert.equal(invoke.kind, "http");
    assert.ok(invoke.url.startsWith("https://tidycal.com/"), record.payload.id);
    assert.deepEqual(invoke.may_reach, ["tidycal.com"]);
    for (const injection of invoke.credential_injections) {
      assert.equal(injection.secret_name, "tidycal-api-token");
      assert.equal(injection.placement.name, "Authorization");
      assert.equal(injection.placement.prefix, "Bearer ");
    }
  }
});

test("the cancel row sends PATCH to the booking's cancel route, the method TidyCal answers with (POST answers 405)", () => {
  const cancel = rows.records.find(record => record.payload.id === "tool:cancel-a-tidycal-booking");
  assert.ok(cancel, "the cancel row is in the rows");
  assert.equal(cancel.payload.invoke.method, "PATCH");
  assert.equal(cancel.payload.invoke.url, "https://tidycal.com/api/bookings/{booking_id}/cancel");
});
