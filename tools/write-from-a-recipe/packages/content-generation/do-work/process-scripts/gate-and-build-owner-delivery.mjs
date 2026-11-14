#!/usr/bin/env node
import {plainObject,readJsonArg,evaluateGate,buildOwnerDelivery} from "./gate-and-build-owner-delivery-lib.mjs";
function argumentValue(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
const recipeValue = readJsonArg(argumentValue("--recipe-json"), {});
const recipe = plainObject(recipeValue) ? recipeValue : {};
const itemValue = readJsonArg(argumentValue("--produced-item-json"), {});
if (!plainObject(itemValue)) { process.stderr.write("produced item is not a JSON object\n"); process.exit(4); }
const grounding = readJsonArg(argumentValue("--grounding-json"), []);
const workItemValue = readJsonArg(argumentValue("--work-item-json"), {});
const contextValue = readJsonArg(argumentValue("--context-json"), {});
const workItem = plainObject(workItemValue) ? workItemValue : {};
const context = plainObject(contextValue) ? contextValue : {};
const policy = plainObject(recipe.gate_policy) ? recipe.gate_policy : {};
const [passed, rejectCode, rejectReason] = evaluateGate(itemValue, policy, grounding);
if (!passed) {
  process.stderr.write(`REJECTED [${rejectCode}]: ${rejectReason}\n`);
  process.exit(7);
}
const requiredVerdicts = policy.required_verdicts ?? [];
const review = readJsonArg(argumentValue('--semantic-review-json'), null);
if (!Array.isArray(requiredVerdicts)
  || (requiredVerdicts.length > 0 && (!plainObject(review) || review.accepted !== true
    || !Array.isArray(review.verdicts) || review.verdicts.length !== requiredVerdicts.length
    || requiredVerdicts.some((row, index) => review.verdicts[index]?.id !== row?.id
      || review.verdicts[index]?.accepted !== true)))) {
  process.stderr.write('REJECTED [semantic_review_failed]: required calibrated review did not accept the draft\n');
  process.exit(7);
}
const [delivered, delivery, deliveryError] = buildOwnerDelivery(itemValue,workItem,context,recipe.delivery_target);
if (!delivered) {
  process.stderr.write(`REJECTED [invalid_delivery_target]: ${deliveryError}\n`);
  process.exit(7);
}
const result = {passed:true,delivery};
const dispatchRunId = argumentValue('--dispatch-request-id');
if (process.argv.includes('--dispatch-request-id')) {
  if (typeof dispatchRunId !== 'string' || !dispatchRunId.trim() || dispatchRunId.startsWith('--')) {
    process.stderr.write('A saved request identity is required for delivery.\n');
    process.exit(7);
  }
  const requestId = `owner-delivery::${dispatchRunId}`;
  result.dispatch_request = {kind:'content-generation.dispatch-request', id:requestId,
    request_id:requestId, definition_id:delivery.definition_id, input:delivery.input,
    source_request_id:dispatchRunId, lifecycle:{state:'pending',attempt:0,terminal:false},
    idempotency_key:requestId};
  if (plainObject(recipe.verified_continuation)) result.dispatch_request.verified_continuation = recipe.verified_continuation;
  result.dispatch_address = `content-generation.dispatch-request::${requestId}`;
}
process.stdout.write(JSON.stringify(result));
