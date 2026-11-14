// packages/motion-analysis/do-work/process-scripts/match/publish_perception_records.mjs
//
// Browser on-device perception → live-log FACT DELIVERY seam.
// =============================================================================
// The on-device runtime (Pyodide + onnxruntime-web) runs the SAME canonical .py leaves as the
// native worker and produces the IDENTICAL command-output ({facts, records, summary}). This
// module delivers that output to the live log so the ALREADY-LIVE derivation layer
// (progression-evaluator measures + measure-projection-materializer + visual-database)
// consumes it — with ZERO new endpoint and ZERO new record vocabulary.
//
// L093 / NO GOD PACKAGE (verified against the contract, not invented):
//   The browser reuses the EXISTING motion-analysis admission pieces exactly as the native
//   worker's flow does:
//     1. the record-maker `make-motion-analysis-records-from-command-output.py` turns a
//        command-output into canonical records — each `{address, path, payload}`, self-describing
//        (proven on the real 73-fact fixture: 60 court + 13 ball records).
//     2. the generic per-record writer workflow-action
//        `action:write-motion-analysis-record-from-command-run` (motion-analysis
//        `workflow-action::write-command-run-record`) writes ONE record to `record.address`
//        (path current-item/published-record) from `record.payload`. Its input_schema is
//        `{required:["record"], record:{address,payload}}`.
//   This module ONLY composes those two — it does NOT re-implement the record-maker, does NOT
//   own an AI/scheduler/measure, does NOT mint a browser-specific write endpoint. The browser
//   is the native worker's PEER: same leaves, same records, same writer action; only the
//   execution backend (Pyodide+ort-web vs OsProcessBackend) and the frame source (<video> vs
//   cv2) differ — both DATA/capability-selected (see ort_session.mjs; gap-2 architecture).
//
// NON-NEGOTIABLE INVARIANTS:
//   - No perception vocabulary here (L090): this seam operates on opaque `{address, payload}`
//     records + an opaque command-output. It never names court/ball/rally/shot. If the leaves
//     emit a new fact kind tomorrow, this seam is unchanged.
//   - Serialized writes (loop discipline): records are dispatched one at a time, in order, so a
//     single log is never hit by two concurrent writes from this driver.
//   - Injected capabilities (testable with zero live engine): the record-maker and the Envelope
//     dispatcher are injected. The builder is pure.
// =============================================================================

// The EXISTING generic per-record writer action (motion-analysis). Reused, never re-minted.
export const RECORD_WRITE_ACTION_ID = "action:write-motion-analysis-record-from-command-run";

/**
 * Pure: canonical records (each `{address, payload[, path]}` from the record-maker) → the
 * ordered sequence of dispatch descriptors for the existing writer action. Records missing an
 * address or a non-empty object payload are dropped (fail-closed — the writer's input_schema
 * requires `record.address` + `record.payload`; a malformed record is never dispatched).
 *
 * @param {{address:string,payload:object}[]} records
 * @param {{actionId?:string}} [opts]
 * @returns {{action_id:string, input:{record:{address:string,payload:object}}}[]}
 */
export function buildRecordWriteDispatches(records, opts = {}) {
  const actionId = opts.actionId ?? RECORD_WRITE_ACTION_ID;
  return (Array.isArray(records) ? records : [])
    .filter(
      (r) =>
        r &&
        typeof r.address === "string" &&
        r.address.length > 0 &&
        r.payload &&
        typeof r.payload === "object" &&
        Object.keys(r.payload).length > 0,
    )
    .map((r) => ({
      action_id: actionId,
      input: { record: { address: r.address, payload: r.payload } },
    }));
}

/**
 * Deliver one on-device command-output to the live log via the EXISTING packages.
 *
 * @param {object} request        the motion-analysis request ({request_id, sources, ...})
 * @param {object} commandOutput  the on-device runtime's {facts, records, summary}
 * @param {object} caps
 * @param {(request,commandOutput)=>Promise<{records:object[]}>} caps.makeRecords
 *        runs the existing record-maker (browser: in Pyodide; test: injected)
 * @param {(dispatch:{action_id:string,input:object})=>Promise<any>} caps.dispatch
 *        sends one workflow-action dispatch to its Envelope target (browser: the live engine;
 *        test: a spy). Writes are serialized (awaited in order).
 * @returns {Promise<{count:number, dispatches:object[], results:any[]}>}
 */
export async function deliverPerceptionCommandOutput(request, commandOutput, caps = {}) {
  const { makeRecords, dispatch } = caps;
  if (typeof makeRecords !== "function") throw new Error("deliverPerceptionCommandOutput: makeRecords capability required");
  if (typeof dispatch !== "function") throw new Error("deliverPerceptionCommandOutput: dispatch capability required");
  const made = await makeRecords(request, commandOutput);
  const records = (made && Array.isArray(made.records)) ? made.records : [];
  const dispatches = buildRecordWriteDispatches(records);
  const results = [];
  for (const d of dispatches) results.push(await dispatch(d)); // serialized (one write at a time)
  return { count: dispatches.length, dispatches, results };
}
