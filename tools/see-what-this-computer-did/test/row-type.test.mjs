// The kind this tool owns must be the row type the app writes its event rows with.
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const appReader = process.env.TRILLION_APPS_READER || `${process.env.HOME}/dev/trillion-apps/macos/computer-reader.json`;

test("the computer-event kind matches the app's event_rows row type", { skip: !existsSync(appReader) && "trillion-apps not checked out here" }, () => {
  const tool = JSON.parse(readFileSync(new URL("../tool-rows.json", import.meta.url), "utf8"));
  const kinds = tool.records[0].payload.record_model.kinds.map((kind) => kind.type);
  const app = JSON.parse(readFileSync(appReader, "utf8"));
  assert.deepEqual(kinds, [app.app.event_rows.row_type]);
  assert.equal(tool.records[0].payload.record_model.kinds[0].merge, "crdt");
});
