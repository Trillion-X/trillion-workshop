// Workshop operations in a shared Space. These keep the familiar typed operations
// while binding each request to an explicitly named Space; private Workshop tools
// remain unchanged and continue to use the account's private context.
const spaceId = { type: 'string', minLength: 1, description: 'The space_id returned by list_pursuits' };
const toolId = { type: 'string', minLength: 1, description: 'A tool_id returned by find_space_tool_for_job or list_space_tools' };
const taskId = { type: 'string', minLength: 1, description: 'A task_id returned by run_space_tool' };

/** Space-bound Workshop tools for credentials whose reach may exclude private Trillion data. */
export function contextWorkshopTools(call) {
  const at = space_id => `/spaces/${encodeURIComponent(space_id)}/workshop`;
  const grantId = { type: 'string', minLength: 1, description: 'The grant_id returned by find_space_tool_for_job or list_space_tools' };
  const tool = (name, description, inputSchema, run) => ({ name, description, inputSchema, run, reach: 'spaces' });
  return [
    tool('find_space_tool_for_job', 'Finds Marketplace tools granted in one shared pursuit for a job described in plain words. Returns only tools this pursuit grants, with each tool_id, job, input_schema, where it runs, reported outcomes and a run_space_tool call. It runs nothing and never searches private Trillion.', {
      type: 'object', required: ['space_id', 'job'], properties: { space_id: spaceId, job: { type: 'string', minLength: 1, description: 'What needs doing, in plain words' }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    }, ({ space_id, job, limit }) => call(`${at(space_id)}/find`, { job, ...(limit === undefined ? {} : { limit }) })),
    tool('describe_space_tool', 'Reads the descriptor for a tool granted in one shared pursuit, including its version, input and output schemas, run location and licence. It does not return another member’s credentials or private files, and does not run the tool.', {
      type: 'object', required: ['space_id', 'tool_id', 'grant_id'], properties: { space_id: spaceId, tool_id: toolId, grant_id: grantId },
    }, ({ space_id, tool_id, grant_id }) => call(`${at(space_id)}/describe`, { tool_id, grant_id })),
    tool('run_space_tool', 'Runs a tool granted in one shared pursuit using that pursuit’s execution settings and result destination. Give the tool_id from find_space_tool_for_job and input matching its schema. request_key makes retries return the same task instead of running twice. A queued or longer run returns a task_id for read_space_task. The run is refused if the member, grant or pinned tool version is no longer active.', {
      type: 'object', required: ['space_id', 'tool_id', 'grant_id', 'input', 'request_key'], properties: { space_id: spaceId, tool_id: toolId, grant_id: grantId, input: { type: 'object' }, request_key: { type: 'string', minLength: 1 }, wait_seconds: { type: 'number', minimum: 0, maximum: 50 }, run_at: { type: 'string', format: 'date-time', description: 'When to run it, so a grant can be revoked before it starts' }, job: { type: 'string' } },
    }, ({ space_id, ...run }) => call(`${at(space_id)}/run`, run)),
    tool('read_space_task', 'Reads a tool run started in one shared space: its state, checked result, run location, error and reports. This operation can release finished execution resources, settle interrupted or revoked tasks, and resume eligible unfinished runs. The pursuit must still authorize this sign-in and the task; a task_id from private Trillion cannot be read here.', {
      type: 'object', required: ['space_id', 'grant_id', 'task_id'], properties: { space_id: spaceId, grant_id: grantId, task_id: taskId },
    }, ({ space_id, grant_id, task_id }) => call(`${at(space_id)}/read`, { grant_id, task_id })),
    tool('snapshot_space_task', 'Reads only the saved state and checked result of a tool run in one shared pursuit without recovery, executor observation, cleanup or task changes. The current member, grant, tool version and exact pursuit task must still match. A private task or a task from another pursuit cannot be read here. A saved working state does not prove the executor is still running. read_space_task is the separate recovery operation.', {
      type: 'object', additionalProperties: false, required: ['space_id', 'grant_id', 'task_id'], properties: { space_id: spaceId, grant_id: grantId, task_id: taskId },
    }, ({ space_id, grant_id, task_id }) => call(`${at(space_id)}/snapshot`, { grant_id, task_id })),
  ];
}

export const contextWorkshopAnnotations = {
  find_space_tool_for_job: { title: 'Find a tool in a pursuit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  describe_space_tool: { title: 'Read a tool granted in a pursuit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_space_tool: { title: 'Run a tool in a pursuit', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  read_space_task: { title: 'Read and recover a tool run in a pursuit', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  snapshot_space_task: { title: 'Inspect a saved tool run in a pursuit', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
