// src/show-rules-tools.mjs
//
// Purpose
//   The MCP tools over the person store's /show-rules routes (src/show-rules-store.mjs): read_show_rules, set_show_rule
//   and remove_show_rule, with their titles and hints. Kept apart so the tool list (src/tools.mjs) loads in node.
//

const tree = 'A rule is the formula engine\'s tree { kind: "group", combinator: "and" | "or", negate: false, rules: [{ kind: "rule", field, operator, params }] } over the facts read_show_rules lists for the subject and for the moment (hour 0-23 and weekday in the rule\'s time_zone, device phone/tablet/computer, arrived_by_link yes/no, channel: where it is shown, such as phone or email; now is a date in milliseconds).';

/** The MCP tools over the person store's /show-rules routes. */
export const showRuleTools = call => [
  { name: 'read_show_rules', description: 'The rules that decide whether anything Trillion would show this person (a notice, a tour, a layout in the Layouts menu, any control, any surface) shows, is silenced or is hidden: every rule they keep (starting rules everyone has, with whether each is on, then their own, then the rules the service\'s owner gives them, marked with `given` and not removable by them), the types (presets) they can keep or give, and the edit rules that decide which trusted account actor may change rules, types, or other edit rules and until when. It also reads subjects, facts, effects and operators. It changes nothing. The service owner can pass accounts: { filter? } to list known accounts for assignment.', inputSchema: {
    type: 'object',
    properties: {
      accounts: { type: 'object', description: '{ filter? }: list the accounts (the service owner only). filter is a rule tree over account_id, created_at, cohorts, experiments, bucket, like { kind: "group", combinator: "and", negate: false, rules: [{ kind: "rule", field: "cohorts", operator: "has_any_of", params: { values: ["simple-workspace"] } }] }' },
    },
  }, run: ({ accounts }) => (accounts ? call('/show-rules/accounts', accounts) : call('/show-rules')) },
  { name: 'set_show_rule', description: `Keeps one show rule, changes a starting rule, or changes the edit rules that govern trusted account actors. attribute { id, label } declares a tags field through change_attribute; give.attributes assigns its declared ids through change_assignment. A show rule is { id?, label, subject, effect: show|hide|silence|change, when?, until?, time_zone? }; until expires it. edit_rules replaces the full list of { id, effect: allow|deny, who: { kind: account_owner } or { kind: reader, reader }, actions: [change_rule, remove_rule, toggle_starting, change_type, remove_type, change_edit_rules, change_assignment, change_attribute], when?, until? }. A reader id must come from the authenticated request; body fields such as by or actor do not establish identity. An allow expires or a deny takes precedence by effect strength; without a winning allow the change is refused. Current rules must authorize changing edit_rules, and the proposed list must still authorize that actor to change edit rules. ${tree} Every control is subject "control", named by a dotted path declared in part.json controls. read_show_rules lists every declared control with its label and parent; "within" holds the control and each dotted ancestor, so one action or a whole branch can be hidden. type.scope { space_id } limits a profile and its inherited rules to that Space.`, inputSchema: {
    type: 'object',
    properties: {
      rule: { type: 'object', description: '{ id?, label, subject, effect, when?, until?, time_zone?, audience? }' },
      edit_rules: { type: 'array', minItems: 1, maxItems: 100, description: 'Replace the full edit-authority rule list. Rules use allow/deny effects, account_owner or one authenticated reader as who, actions, optional when and until.' },
      starting: { type: 'object', description: '{ id, on }: turn a starting rule off (on false) or back on' },
      type: { type: 'object', description: '{ id, label, inherits?, rules, audience?, scope? }: keep a profile. scope { space_id } limits it to one space. It applies only while you switch it on with use; an audience on your own profile is not matched.' },
      remove_type: { type: 'string', description: 'The id of one of your own types to take away' },
      use: { type: 'object', description: '{ type, on }: switch one of your own kept profiles on (true) or off (false), through change_type authorization. Own activation affects visibility only; read_show_rules lists in_use.' },
      give: { type: 'object', description: '{ account_id, add?: [type ids], remove?: [type ids], cohorts?: {add?: [ids], remove?: [ids]}, experiments?: {add?: [ids], remove?: [ids]}, attributes?: { <declared id>: {add?: [ids], remove?: [ids]} }: the service owner gives types and audience memberships to an account atomically. The authenticated actor must be allowed change_assignment by the current edit policy; self-assignment must preserve that permission under the proposed memberships. Existing memberships are retained unless explicitly removed. Aimed rules and tours evaluate these current cohort and experiment facts.' },
      attribute: { type: 'object', description: '{ id, label }: the service owner declares an attribute, a tags field (lowercase id) that audiences can name in rules and give per account. It is kept once and listed by read_show_rules.' },
      by: { type: 'string', description: 'Your name as the person knows you, such as Claude or ChatGPT' },
    },
  }, run: ({ by, rule, starting, type, remove_type: removeType, edit_rules, use, give, attribute }) => call('/show-rules/set', edit_rules ? { edit_rules } : starting ? { starting } : type ? { type } : removeType ? { remove_type: removeType } : use ? { use } : give ? { give } : attribute ? { attribute }
    : { rule: by && rule && !rule.by ? { ...rule, by } : rule }) },
  { name: 'remove_show_rule', description: 'Takes one of the person\'s show rules away (id from read_show_rules); a starting rule\'s id turns that starting rule off.', inputSchema: {
    type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'A rule id from read_show_rules' } },
  }, run: input => call('/show-rules/remove', input) },
  { name: 'resolve_show_rules_conflict', description: 'Keeps one exact persisted show-rules version from an open workspace conflict. Read the conflict first and pass its id and the selected branch identity; the rule owner validates every changed rule family and future edit authority before resolving.', inputSchema: {
    type: 'object', required: ['id', 'branch_identity'], properties: {
      id: { type: 'string', description: 'The open conflict id from read_workspace_conflict.' },
      branch_identity: { type: 'string', description: 'The exact identity of one stored branch in that conflict.' },
    },
  }, run: input => call('/show-rules/resolve', input) },
];

export const showRuleAnnotations = {
  read_show_rules: { title: 'Read what decides what I am shown', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_show_rule: { title: 'Show, hide or silence something by a rule', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  remove_show_rule: { title: 'Take a show rule away', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  resolve_show_rules_conflict: { title: 'Keep a show-rules conflict version', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};
