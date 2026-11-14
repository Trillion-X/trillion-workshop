// A tool opened in a pursuit uses that pursuit's grant owner. A personal tool's run is the one run owner's request
// (workshop-tool-api.ts toolRunRequest); its describe keeps the Workshop road. An invalid pursuit never falls back to them.
import { toolRunRequest } from './workshop-tool-api.ts';

export function toolScreenRequest(toolId, surfaceInput, operation, body = {}) {
  if (typeof toolId !== 'string' || !toolId) throw new Error('Choose a tool to open.');
  const input = surfaceInput ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('The tool could not open.');
  const given = input.space_id;
  const company = given !== undefined && given !== null;
  const space = typeof given === 'string' ? given.trim() : '';
  if (company && (!space || space.includes('/'))) throw new Error('This pursuit could not open its tool.');
  const at = company ? '/work/api/spaces/' + encodeURIComponent(space) + '/workshop/' : '/work/api/workshop/';
  if (operation === 'describe') {
    return { path: company ? at + 'describe?tool_id=' + encodeURIComponent(toolId) : at + 'describe/' + encodeURIComponent(toolId), init: {} };
  }
  if (operation === 'context') {
    if (company) throw new Error('Private saved screen context is unavailable in a pursuit.');
    return { path: '/work/api/workshop/screen-context', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool_id: toolId, ...(input.screen_context_id ? { screen_context_id: input.screen_context_id } : {}) }) } };
  }
  if (operation !== 'run') throw new Error('This tool action could not be read.');
  if (!company) return toolRunRequest(toolId, body.input ?? {}, body.request_key);
  return {
    path: at + 'run',
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, tool_id: toolId }) },
  };
}
