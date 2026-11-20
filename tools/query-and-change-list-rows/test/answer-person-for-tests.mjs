// The person the answer tests use (test/answer-content-index.test.mjs, test/answer-reports.test.mjs), as old trillion
// test/answer-test-person.mjs made it: the record store, the list routes with the rule evaluator, and the list MCP tools
// over those routes. Old src/search.mjs, which the old person also answered questions with, has no JavaScript home: the
// engine answers search (trillion-rust src/record_value/search.rs), so this person has no `ask`.
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { handleListsRequest, makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { listTools } from '../src/list-tools.mjs';
import { evaluateBinding, filterRows, ruleKindOf } from '../../keep-and-wake-ai-sessions-on-this-computer/test/formula-views-for-tests.mjs';

const views = { filterRows, ruleKindOf, evaluateBinding };

/** A person whose store is in `file` (in memory when left out). */
export function person(file = ':memory:') {
  const { sql, transaction } = sqliteHost(file);
  const { eeaf } = decisionStore(sql, { transaction });
  const lists = makeLists({ eeaf });
  const calls = [];
  const call = async (path, body) => {
    calls.push(path);
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'x-trillion-app': 'Claude' } }), views);
    const answer = await response.json();
    if (!response.ok) throw Object.assign(new Error(answer.error ?? `status ${response.status}`), { status: response.status, refused: answer.refused });
    return answer;
  };
  const tools = Object.fromEntries(listTools(call).map(tool => [tool.name, input => tool.run(input)]));
  return { eeaf, lists, tools, calls };
}
