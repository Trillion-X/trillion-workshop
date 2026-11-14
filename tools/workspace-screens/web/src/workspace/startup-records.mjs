// src/workspace/startup-records.mjs
//
// The one bounded read of the saved records the first paint depends on (first-answers.json startup_record_inputs: where
// the sidebar sits, the arrangement, the saved layouts, the sidebar's list, the look). The Worker writes its answer into
// the page (src/worker.mjs workspacePage) and the page reads it at this same address (src/workspace/records.ts
// readStartupRecords), so both name the address from these rows and cannot disagree.
import firstAnswers from './first-answers.json' with { type: 'json' };
import inputs from './inputs.json' with { type: 'json' };

/** The address label of each startup input, in the order first-answers.json names them. */
export const startupRecordLabels = [...firstAnswers.startup_record_inputs.map(name => {
  const address = inputs[name]?.address;
  if (!address) throw new TypeError(`The startup input "${name}" does not name a record address.`);
  return address;
}), ...(firstAnswers.startup_preferences ?? []).map(key => `workspace-preference:${key}`)];

/** The address the page reads them at: one request naming every label. */
export const startupRecordsPath = `${firstAnswers.workspace_records_path}?${startupRecordLabels.map(label => `label=${encodeURIComponent(label)}`).join('&')}`;
