// The complete write contract exposed to schema-driven AI clients. The backend
// remains the existing workflow owner; arbitrary JSON schemas and engine graphs
// are preserved rather than narrowed to the fields a particular editor happens to show.
// Each field's guidance is DATA (src/workflow-authoring-guidance.json), written in as its description.
import { withFieldGuidance } from './workflow-authoring-guidance.mjs';

export const workflowRecipeInput = withFieldGuidance({
  type: 'object', required: ['id', 'job'], additionalProperties: true,
  properties: {
    id: { type: 'string', description: 'Stable workflow:<name> id; reuse it to edit this account\'s existing workflow.' },
    label: { type: 'string' }, job: { type: 'string' },
    input_schema: { type: 'object', additionalProperties: true, description: 'JSON Schema with type object for the workflow input.' },
    steps: { type: 'array', items: {
      type: 'object', required: ['id', 'do', 'submit'], additionalProperties: true,
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, do: { type: 'string' },
        submit: { type: 'object', additionalProperties: true },
        actor_policy: { type: 'object', required: ['authenticated'], additionalProperties: false, description: 'Require the actual authenticated author; distinct_from compares admitted actor evidence of prior steps, never supplied author names. App identities identify an app, not separate AI processes.', properties: {
          authenticated: { const: true }, distinct_from: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string' } },
          distinct_from_if_admitted: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string' }, description: 'Compare with a prior conditional step only if it actually has an admitted answer; unknown actor evidence in an admitted step still refuses.' },
        } },
        checks: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
          says: { type: 'string' }, kind: { type: 'string' },
          path: { type: 'array', items: {} }, of: { type: 'array', items: {} }, in: { type: 'array', items: {} },
          values: { type: 'array', items: {} }, words: { type: 'array', items: { type: 'string' } },
          count: { type: 'integer' }, catalog: { type: 'string' },
        } } },
        run_tool: { type: 'object', required: ['tool_id'], properties: {
          tool_id: { type: 'string' }, input: { type: 'object', additionalProperties: true },
          pinned: { type: 'object', description: 'The tool version this step was written for, filled in when saved; keep it as describe_workflow shows it, and move it with upgrade_workflow_steps.', properties: {
            version: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } },
          } },
        } },
      },
    } },
    definition: { type: 'object', additionalProperties: true, description: 'Instead of ordered steps, the existing engine step graph, including edges and bindings.', properties: {
      steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
      edges: { type: 'array', items: { type: 'object', additionalProperties: true } },
    } },
    show_on_public_site: { type: 'boolean', description: 'After publish_workflow, show only this workflow’s name and job on public Sites. Visitors cannot run it from a site.' },
    made_from: { type: 'array', items: { type: 'string' }, description: 'The workflows this one was made from (workflow:...).' },
  },
});
