// src/native-tool-command-receipts.mjs
//
// PURPOSE
//   Saving a tool (tools:save, src/workshop.mjs saveTool) keeps its saved row and its exact reply in one transaction
//   (src/native-local-command-receipts.mjs), so a save whose invocation is gone is decided from that one durable effect:
//   committed with its reply when the row was written, aborted when no receipt exists. A retry by the same request key
//   answers that outcome, and the command's credit settles instead of being held.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The row, its private screen context and the reply are written in the same transaction as the receipt.
//   2. A write outside a tools:save command (no admitted tools:save context) writes the row alone, as before.
import { nativeLocalCommandReceipts } from '../../shared-code/src/native-local-command-receipts.mjs';

export function nativeToolCommandReceipts(supplies) {
  return nativeLocalCommandReceipts({ ...supplies, operations: ['tools:save'], receiptPrefix: 'resource-tool-command' });
}

/**
 * The Workshop store's two saved-tool writes over an own-records resource: receipts (nativeToolCommandReceipts),
 * transaction(work), put(key, row), value(key), screenContexts (keep, preserve, forgetTool), toolVersion(row).
 * reply(context) is the save's answer (src/workshop.mjs replyOf); it is kept with the row.
 */
export function receiptedToolWrites({ receipts, transaction, put, value, screenContexts, toolVersion }) {
  const changed = () => Object.assign(new Error('The saved screen changed while its private context was being saved.'), { status: 409 });
  const commit = (row, write) => receipts.commit(() => transaction(write), { operation: 'tools:save', source: `tool:${row.id}` });
  return {
    writeSavedTool(row, { reply = null } = {}) {
      commit(row, () => { put(`tool:${row.id}`, row); return reply ? reply(null) : { tool_id: row.id }; });
    },
    saveScreenTool({ row, input, has_input, preserve, expected_saved_at, expected_version, reply = null }) {
      let context = null;
      commit(row, () => {
        const kept = value(`tool:${row.id}`), prior = kept?.status === 'deleted' ? null : kept;
        if ((prior?.saved_at ?? null) !== expected_saved_at || (prior ? toolVersion(prior) : null) !== expected_version) throw changed();
        if (row.screen?.kind === 'module') context = has_input ? screenContexts.keep({ tool_id: row.id, tool_saved_at: row.saved_at, tool_version: toolVersion(row), input })
          : preserve ? screenContexts.preserve({ tool_id: row.id, tool_saved_at: row.saved_at, tool_version: toolVersion(row) }) : null;
        else screenContexts.forgetTool(row.id);
        put(`tool:${row.id}`, row);
        return reply ? reply(context) : { tool_id: row.id };
      });
      return context;
    },
  };
}
