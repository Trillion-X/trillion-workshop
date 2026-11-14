import assert from "node:assert/strict";
import test from "node:test";

import { admissionInspectionForHeldImage } from "./ask-a-runtime-provider-which-images-it-holds.mjs";

const config = `sha256:${"4".repeat(64)}`;
const layers = [
  `sha256:${"5".repeat(64)}`,
  `sha256:${"6".repeat(64)}`,
];

test("returns only the exact immutable image fields used by admission", () => {
  assert.deepEqual(
    admissionInspectionForHeldImage(
      { Id: config, RepoDigests: [] },
      {
        Id: config,
        RepoDigests: [],
        RootFS: { Type: "layers", Layers: layers },
        Config: { Env: ["PRIVATE=value"] },
        GraphDriver: { Data: { LowerDir: "/host/private" } },
      },
    ),
    {
      Id: config,
      RepoDigests: [],
      RootFS: { Type: "layers", Layers: layers },
    },
  );
});

test("refuses a list-to-inspection config identity switch", () => {
  assert.throws(
    () =>
      admissionInspectionForHeldImage(
        { Id: config, RepoDigests: [] },
        {
          Id: `sha256:${"7".repeat(64)}`,
          RepoDigests: [],
          RootFS: { Type: "layers", Layers: layers },
        },
      ),
    /same config identity/,
  );
});
