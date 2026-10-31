// tools/write-from-a-recipe/read-data/check-writing.mjs
//
// Generic fail-closed gate over writing an AI made from a recipe, plus the builder of the one request that hands the
// accepted writing to the next tool the recipe names. Ported from bitfield-packages
// packages/content-generation/do-work/process-scripts/gate-and-build-owner-delivery-lib.mjs.
//
// Non-negotiable invariants
//   1. A check row whose kind has no installed capability, or whose params are malformed, fails closed: nothing passes
//      on an unenforced check.
//   2. The checks here judge the writing against the sources the caller supplied (grounding): enough sources, and every
//      citation names a supplied source. Rules about the words themselves or values in the writing are judge-words
//      rows (tools/judge-words), judged by that one judge, never by a second one here.
//   3. A rejection carries no handoff. An accepted writing has at most one handoff: { tool_id, input }, every input
//      value taken from the writing, the work item, the caller's context, derived text or a recipe literal.
//   4. This file writes no markup of its own: how a derived body wraps its headings and paragraphs is the recipe's
//      `body_render.wrap` DATA, escaped as HTML only when the recipe says `escape: "html"`.
//   5. A required verdict is accepted only when the review names exactly the required ids, in order, each accepted.

const asString = (value) => (typeof value === "string" ? value : "");
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function collectProvidedIds(grounding, idField) {
  const ids = new Set();
  if (!Array.isArray(grounding)) return ids;
  for (const excerpt of grounding) if (plainObject(excerpt)) {
    const id = excerpt[idField];
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}
function collectCitedIds(item, specs) {
  const cited = new Set();
  if (!Array.isArray(specs)) return cited;
  for (const spec of specs) {
    if (!plainObject(spec)) continue;
    const arrayKey = asString(spec.array), idsKey = asString(spec.ids_key);
    if (!arrayKey || !idsKey || !Array.isArray(item[arrayKey])) continue;
    for (const element of item[arrayKey]) {
      if (!plainObject(element)) continue;
      const raw = element[idsKey];
      if (Array.isArray(raw)) {
        for (const id of raw) if (typeof id === "string" && id) cited.add(id);
      } else if (typeof raw === "string" && raw) cited.add(raw);
    }
  }
  return cited;
}
const overlap = (a, b) => [...a].some((value) => b.has(value));
function minGroundingExcerpts(item, params, ctx) {
  const min = params.min;
  if (!Number.isSafeInteger(min) || min <= 0) return [false, "min-grounding-excerpts requires a positive integer 'min' param; refusing to pass an unenforceable check"];
  if (ctx.providedIds.size < min) return [false, `required >= ${min} grounding excerpts but only ${ctx.providedIds.size} were provided`];
  return [true, ""];
}
function citeOrReject(item, params, ctx) {
  if (!ctx.providedIds.size) return [true, ""];
  const cited = collectCitedIds(item, ctx.citationSpecs);
  if (!overlap(ctx.providedIds, cited)) return [false, `grounding was provided (${ctx.providedIds.size} ids) but the item cited none of the owner's source ids; refusing owner delivery of uncited content`];
  return [true, ""];
}
function requiredCitationCoverage(item, params, ctx) {
  const specs = params.specs;
  if (!Array.isArray(specs) || !specs.length) return [false, "required-citation-coverage requires a non-empty 'specs' DATA list"];
  for (const spec of specs) {
    if (!plainObject(spec)) return [false, "required-citation-coverage rows must be objects"];
    const arrayKey = asString(spec.array), idsKey = asString(spec.ids_key), minElements = spec.min_elements ?? 0;
    if (!arrayKey || !idsKey) return [false, "required-citation-coverage rows require array and ids_key"];
    if (!Number.isSafeInteger(minElements) || minElements < 0) return [false, `required-citation-coverage '${arrayKey}' min_elements must be a non-negative integer`];
    const elements = item[arrayKey];
    if (!Array.isArray(elements)) return [false, `required citation array '${arrayKey}' is absent or not a list`];
    if (elements.length < minElements) return [false, `required citation array '${arrayKey}' has ${elements.length} elements but needs at least ${minElements}`];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (!plainObject(element)) return [false, `required citation array '${arrayKey}' element ${index} is not an object`];
      const raw = element[idsKey], rawIds = Array.isArray(raw) ? raw : [raw];
      if (rawIds.some(id => typeof id !== "string" || !id.trim())) return [false, "A citation is invalid. Every citation must name a supplied source."];
      const cited = new Set(rawIds.filter((id) => typeof id === "string" && id));
      if (!cited.size) return [false, `required citation array '${arrayKey}' element ${index} has no '${idsKey}' value`];
      const unknown = [...cited].filter((id) => !ctx.providedIds.has(id));
      if (unknown.length) return [false, `required citation array '${arrayKey}' element ${index} cites unsupplied grounding id(s): ${unknown.sort().join(", ")}`];
    }
  }
  return [true, ""];
}
const capabilities = new Map([
  ["min-grounding-excerpts", minGroundingExcerpts],
  ["cite-or-reject", citeOrReject],
  ["required-citation-coverage", requiredCitationCoverage],
]);
function normalizeChecks(policy) {
  if (Array.isArray(policy.checks) && policy.checks.length) return [...policy.checks];
  const checks = [];
  if (policy.grounded === true && Number.isSafeInteger(policy.min_excerpts) && policy.min_excerpts > 0) checks.push({kind:"min-grounding-excerpts",params:{min:policy.min_excerpts}});
  if (policy.cite_or_reject === true) checks.push({kind:"cite-or-reject",params:{}});
  return checks;
}
function evaluateGate(item, policy, grounding) {
  const idField = asString(policy.grounding_id_field) || "source_ref";
  const ctx = {providedIds:collectProvidedIds(grounding,idField),idField,citationSpecs:policy.citation_specs,grounding,materialization:{}};
  for (const check of normalizeChecks(policy)) {
    if (!plainObject(check)) return [false,"malformed_gate_check",`gate check row is not an object (${Array.isArray(check) ? "array" : typeof check}); refusing to pass an unenforceable check`];
    const kind = asString(check.kind), capability = capabilities.get(kind);
    if (!capability) return [false,"unknown_gate_check",`gate check '${kind || "(missing kind)"}' has no installed capability; failing closed rather than passing an unenforced check`];
    if (check.params != null && !plainObject(check.params)) return [false,"malformed_gate_check",`gate check '${kind}' has non-object params (${Array.isArray(check.params) ? "array" : typeof check.params}); refusing to pass an unenforceable check`];
    const [passed, reason] = capability(item, plainObject(check.params) ? check.params : {}, ctx);
    if (!passed) return [false,`gate_check_failed:${kind}`,reason];
  }
  return [true, "", ""];
}
// A required verdict list (`policy.required_verdicts`, rows with an `id`) is met only by a review that accepted, with
// one accepted verdict per required row, in the same order and with the same id.
function requiredVerdictsMet(policy, review) {
  const requiredVerdicts = policy.required_verdicts ?? [];
  return Array.isArray(requiredVerdicts)
    && (requiredVerdicts.length === 0 || (plainObject(review) && review.accepted === true
      && Array.isArray(review.verdicts) && review.verdicts.length === requiredVerdicts.length
      && requiredVerdicts.every((row, index) => review.verdicts[index]?.id === row?.id
        && review.verdicts[index]?.accepted === true)));
}
function flattenSummary(item, spec) {
  if (!plainObject(spec)) return "";
  const arrayKey = asString(spec.array), textKey = asString(spec.text_key) || "text";
  for (const element of Array.isArray(item[arrayKey]) ? item[arrayKey] : []) {
    if (plainObject(element) && typeof element[textKey] === "string" && element[textKey].trim()) return element[textKey].trim();
  }
  return "";
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#x27;" })[char]);
// One piece of a derived body: its text, escaped when the recipe asks, between the recipe's own before and after.
function wrapped(render, role, value) {
  const wrap = plainObject(render.wrap) && Array.isArray(render.wrap[role]) ? render.wrap[role] : ["", ""];
  const text = render.escape === "html" ? escapeHtml(value) : String(value);
  return `${asString(wrap[0])}${text}${asString(wrap[1])}`;
}
function flattenBody(item, render) {
  if (!plainObject(render)) return "";
  const parts = [];
  const blocks = plainObject(render.blocks) ? render.blocks : null;
  if (blocks) {
    const arrayKey = asString(blocks.array), headingKey = asString(blocks.heading_key) || "heading", textKey = asString(blocks.text_key) || "text";
    for (const block of Array.isArray(item[arrayKey]) ? item[arrayKey] : []) {
      if (!plainObject(block)) continue;
      if (block[headingKey]) parts.push(wrapped(render, "heading", block[headingKey]));
      if (block[textKey]) parts.push(wrapped(render, "text", block[textKey]));
    }
  }
  const faq = plainObject(render.faq) ? render.faq : null;
  if (faq) {
    const arrayKey = asString(faq.array), questionKey = asString(faq.question_key) || "question", answerKey = asString(faq.answer_key) || "answer";
    const pairs = Array.isArray(item[arrayKey]) ? item[arrayKey] : [];
    if (pairs.length && faq.heading) parts.push(wrapped(render, "heading", faq.heading));
    for (const pair of pairs) {
      if (!plainObject(pair)) continue;
      if (pair[questionKey]) parts.push(wrapped(render, "question", pair[questionKey]));
      if (pair[answerKey]) parts.push(wrapped(render, "text", pair[answerKey]));
    }
  }
  const jsonld = plainObject(render.jsonld) ? render.jsonld : null;
  if (jsonld) {
    const fragments = Array.isArray(item[asString(jsonld.array)]) ? item[asString(jsonld.array)] : [];
    if (fragments.length) {
      const graph = {"@context":asString(jsonld.context) || "https://schema.org","@graph":fragments};
      const wrap = plainObject(render.wrap) && Array.isArray(render.wrap.structured_data) ? render.wrap.structured_data : ["", ""];
      const encoded = JSON.stringify(graph).replaceAll("</script", "<\\/script");
      parts.push(`${asString(wrap[0])}${encoded}${asString(wrap[1])}`);
    }
  }
  return parts.join("\n");
}
function resolveDeliveryValue(spec, item, workItem, context, derived) {
  if (!plainObject(spec)) return [false, undefined, "delivery input value spec must be an object"];
  if (Object.hasOwn(spec, "value")) return [true, spec.value, ""];
  const sourceName = asString(spec.from), field = asString(spec.field);
  const sources = {item, work_item:workItem, context, derived};
  const source = sources[sourceName];
  if (!source || !field) return [false, undefined, "delivery input needs {value} or a known {from,field} source"];
  if (!Object.hasOwn(source, field)) return [false, undefined, `delivery input source '${sourceName}.${field}' is absent`];
  return [true, source[field], ""];
}
function buildOwnerDelivery(item, workItem, context, target) {
  if (!plainObject(target)) return [false, {}, "delivery_target must be an object"];
  const toolId = asString(target.tool_id), inputs = target.input;
  if (!toolId.startsWith("tool:") || !plainObject(inputs) || !Object.keys(inputs).length) return [false, {}, "delivery_target requires a tool: tool_id and a non-empty input mapping"];
  const derived = {summary:flattenSummary(item,target.summary_from),body:flattenBody(item,target.body_render)};
  const ownerInput = {};
  for (const [key, spec] of Object.entries(inputs)) {
    if (!key) return [false, {}, "delivery_target input keys must be non-empty strings"];
    const [ok, value, reason] = resolveDeliveryValue(spec,item,workItem,context,derived);
    if (!ok) return [false, {}, reason];
    ownerInput[key] = value;
  }
  return [true, {tool_id:toolId,input:ownerInput}, ""];
}

export { plainObject, evaluateGate, requiredVerdictsMet, buildOwnerDelivery };
