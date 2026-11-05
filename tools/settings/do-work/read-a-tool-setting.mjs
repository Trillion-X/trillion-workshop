// tools/settings/do-work/read-a-tool-setting.mjs
//
// tool:read-a-tool-setting: { settings_record, tool? } in, { settings_record, tool, scope_kind, scope_id, settings } out.
// For a caller that cannot import read-data/settings.mjs (a Python tool, a person's AI checking a setting): the same
// read, run through tools/records-door do-work/run-an-export.mjs with a right on exactly that one record.
import { readSettings, parseSettingId } from '../read-data/settings.mjs';

export async function readATool(input, { door }) {
  const named = parseSettingId(input?.settings_record);
  const settings = await readSettings(door, input.settings_record, { tool: input.tool ?? named.tool });
  return { settings_record: input.settings_record, ...named, settings };
}
