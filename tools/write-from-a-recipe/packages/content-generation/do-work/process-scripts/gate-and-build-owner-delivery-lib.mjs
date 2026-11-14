#!/usr/bin/env node
// Generic fail-closed gate plus caller-declared owner-delivery builder.
// Accepted result JSON is stdout; rejection exits 7 before any owner handoff.

const asString = (value) => (typeof value === "string" ? value : "");
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function readJsonArg(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
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
function resolvePath(item, path) {
  if (!Array.isArray(path) || !path.length) return undefined;
  let current = item;
  for (const key of path) {
    if (!plainObject(current) || typeof key !== "string") return undefined;
    current = current[key];
  }
  return current;
}
function collectTexts(item, specs) {
  const texts = [];
  if (!Array.isArray(specs)) return texts;
  for (const spec of specs) {
    if (!plainObject(spec)) continue;
    const arrayKey = asString(spec.array), textKey = asString(spec.text_key);
    if (arrayKey) {
      if (!Array.isArray(item[arrayKey])) continue;
      for (const element of item[arrayKey]) {
        if (plainObject(element) && textKey && typeof element[textKey] === "string" && element[textKey].trim()) texts.push(element[textKey]);
        else if (typeof element === "string" && element.trim()) texts.push(element);
      }
    } else if (asString(spec.field)) {
      const value = item[asString(spec.field)];
      if (typeof value === "string" && value.trim()) texts.push(value);
    } else {
      const value = resolvePath(item, spec.path);
      if (typeof value === "string" && value.trim()) texts.push(value);
    }
  }
  return texts;
}
function normalizedPolicyText(value) {
  return value.normalize("NFKC").replace(/\p{Cf}/gu, "").casefold?.() ?? value.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase();
}
function forbiddenTextFragments(item, params, ctx) {
  const specs = params.text_specs;
  if (!Array.isArray(specs) || !specs.length) return [false, "forbidden-text-fragments requires a non-empty 'text_specs' DATA list"];
  for (const spec of specs) {
    if (!plainObject(spec)) return [false, "forbidden-text-fragments text_specs rows must be objects"];
    const arrayKey = asString(spec.array), fieldKey = asString(spec.field), path = spec.path, textKey = asString(spec.text_key);
    const selectorCount = Number(Boolean(arrayKey)) + Number(Boolean(fieldKey)) + Number(Array.isArray(path) && path.length > 0);
    if (selectorCount !== 1) return [false, "forbidden-text-fragments text_specs rows require exactly one of array, field, or path"];
    if (arrayKey && !textKey) return [false, `forbidden-text-fragments array '${arrayKey}' requires text_key`];
    if (path != null && (!Array.isArray(path) || !path.length || !path.every((key) => typeof key === "string" && key))) return [false, "forbidden-text-fragments path must be a non-empty list of string keys"];
  }
  const rows = params.fragments;
  if (!Array.isArray(rows) || !rows.length) return [false, "forbidden-text-fragments requires a non-empty 'fragments' trusted DATA list"];
  const seen = new Set(), fragments = [];
  for (const row of rows) {
    if (!plainObject(row)) return [false, "forbidden-text-fragments fragment rows must be objects"];
    const label = asString(row.label).trim(), value = normalizedPolicyText(asString(row.value));
    if (!label || !value) return [false, "forbidden-text-fragments fragment rows require non-empty label and value"];
    if (seen.has(value)) return [false, `forbidden-text-fragments repeats normalized fragment for trusted label '${label}'`];
    seen.add(value); fragments.push([label, value]);
  }
  for (const text of collectTexts(item, specs)) {
    const normalized = normalizedPolicyText(text);
    for (const [label, fragment] of fragments) if (normalized.includes(fragment)) return [false, `trusted DATA content-safety label '${label}' matched generated prose; refusing owner delivery`];
  }
  return [true, ""];
}
const wordExpression = /[A-Za-z0-9]+/g;
const tokens = (texts) => (` ${texts.join(" ")} `.toLowerCase().match(wordExpression) || []);
function minUniqueRatio(item, params) {
  const min = params.min;
  if (typeof min !== "number" || !Number.isFinite(min) || min <= 0 || min > 1) return [false, "min-unique-ratio requires a 'min' in (0,1]; refusing to pass an unenforceable check"];
  const specs = params.text_specs;
  if (!Array.isArray(specs) || !specs.length) return [false, "min-unique-ratio requires a non-empty 'text_specs' DATA list; refusing to pass an unenforceable check"];
  const n = params.shingle ?? 3;
  if (!Number.isSafeInteger(n) || n <= 0) return [false, "min-unique-ratio 'shingle' must be a positive integer"];
  const words = tokens(collectTexts(item, specs));
  if (words.length < n) return [false, `content too short to evaluate uniqueness (< ${n} words)`];
  const shingles = [];
  for (let index = 0; index <= words.length - n; index++) shingles.push(words.slice(index, index + n).join(" "));
  const ratio = new Set(shingles).size / shingles.length;
  if (ratio < min) return [false, `unique ${n}-gram ratio ${ratio.toFixed(2)} < required ${min}`];
  return [true, ""];
}
function minFactDensity(item, params) {
  const min = params.min;
  if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) return [false, "min-fact-density requires a positive 'min'; refusing to pass an unenforceable check"];
  const perWords = params.per_words ?? 100;
  if (!Number.isSafeInteger(perWords) || perWords <= 0) return [false, "min-fact-density 'per_words' must be a positive integer"];
  const specs = params.text_specs;
  if (!Array.isArray(specs) || !specs.length) return [false, "min-fact-density requires a non-empty 'text_specs' DATA list; refusing to pass an unenforceable check"];
  const words = tokens(collectTexts(item, specs));
  if (!words.length) return [false, "no analyzable text for fact density"];
  const facts = words.filter((word) => /\d/.test(word)).length;
  const density = facts * perWords / words.length;
  if (density < min) return [false, `fact density ${density.toFixed(2)} per ${perWords} words < required ${min}`];
  return [true, ""];
}
function authorEntityPresent(item, params) {
  const path = params.path;
  if (!Array.isArray(path) || !path.length) return [false, "author-entity-present requires a non-empty 'path' DATA list; refusing to pass an unenforceable check"];
  const value = resolvePath(item, path);
  if (typeof value === "string" && value.trim()) return [true, ""];
  if (plainObject(value) && Object.keys(value).length) return [true, ""];
  return [false, `no author entity present at path ${JSON.stringify(path)}; refusing to publish anonymous content`];
}
function demandPresent(item, params) {
  const path = params.path;
  if (!Array.isArray(path) || !path.length) return [false, "demand-present requires a non-empty 'path' DATA list; refusing to pass an unenforceable check"];
  const min = params.min ?? 1;
  if (typeof min !== "number" || !Number.isFinite(min)) return [false, "demand-present 'min' must be a number"];
  const value = resolvePath(item, path);
  if (typeof value !== "number" || !Number.isFinite(value)) return [false, `no numeric demand signal at path ${JSON.stringify(path)}; refusing to publish a topic with unproven demand`];
  if (value < min) return [false, `demand signal ${value} < required ${min}`];
  return [true, ""];
}
const capabilities = new Map([
  ["min-grounding-excerpts", minGroundingExcerpts],
  ["cite-or-reject", citeOrReject],
  ["required-citation-coverage", requiredCitationCoverage],
  ["forbidden-text-fragments", forbiddenTextFragments],
  ["min-unique-ratio", minUniqueRatio],
  ["min-fact-density", minFactDensity],
  ["author-entity-present", authorEntityPresent],
  ["serp-demand-present", demandPresent],
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
function flattenSummary(item, spec) {
  if (!plainObject(spec)) return "";
  const arrayKey = asString(spec.array), textKey = asString(spec.text_key) || "text";
  for (const element of Array.isArray(item[arrayKey]) ? item[arrayKey] : []) {
    if (plainObject(element) && typeof element[textKey] === "string" && element[textKey].trim()) return element[textKey].trim();
  }
  return "";
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#x27;" })[char]);
function flattenBody(item, render) {
  if (!plainObject(render)) return "";
  const parts = [];
  const blocks = plainObject(render.blocks) ? render.blocks : null;
  if (blocks) {
    const arrayKey = asString(blocks.array), headingKey = asString(blocks.heading_key) || "heading", textKey = asString(blocks.text_key) || "text";
    for (const block of Array.isArray(item[arrayKey]) ? item[arrayKey] : []) {
      if (!plainObject(block)) continue;
      if (block[headingKey]) parts.push(`<h2>${escapeHtml(block[headingKey])}</h2>`);
      if (block[textKey]) parts.push(`<p>${escapeHtml(block[textKey])}</p>`);
    }
  }
  const faq = plainObject(render.faq) ? render.faq : null;
  if (faq) {
    const arrayKey = asString(faq.array), questionKey = asString(faq.question_key) || "question", answerKey = asString(faq.answer_key) || "answer";
    const pairs = Array.isArray(item[arrayKey]) ? item[arrayKey] : [];
    if (pairs.length && faq.heading) parts.push(`<h2>${escapeHtml(faq.heading)}</h2>`);
    for (const pair of pairs) {
      if (!plainObject(pair)) continue;
      if (pair[questionKey]) parts.push(`<h3>${escapeHtml(pair[questionKey])}</h3>`);
      if (pair[answerKey]) parts.push(`<p>${escapeHtml(pair[answerKey])}</p>`);
    }
  }
  const jsonld = plainObject(render.jsonld) ? render.jsonld : null;
  if (jsonld) {
    const fragments = Array.isArray(item[asString(jsonld.array)]) ? item[asString(jsonld.array)] : [];
    if (fragments.length) {
      const graph = {"@context":asString(jsonld.context) || "https://schema.org","@graph":fragments};
      const encoded = JSON.stringify(graph).replaceAll("</script", "<\\/script");
      parts.push(`<script type="application/ld+json">${encoded}</script>`);
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
  const definitionId = asString(target.definition_id), inputs = target.input;
  if (!definitionId.startsWith("action:") || !plainObject(inputs) || !Object.keys(inputs).length) return [false, {}, "delivery_target requires action: definition_id and a non-empty input mapping"];
  const derived = {summary:flattenSummary(item,target.summary_from),body:flattenBody(item,target.body_render)};
  const ownerInput = {};
  for (const [key, spec] of Object.entries(inputs)) {
    if (!key) return [false, {}, "delivery_target input keys must be non-empty strings"];
    const [ok, value, reason] = resolveDeliveryValue(spec,item,workItem,context,derived);
    if (!ok) return [false, {}, reason];
    ownerInput[key] = value;
  }
  return [true, {definition_id:definitionId,input:ownerInput}, ""];
}

export { plainObject, readJsonArg, evaluateGate, buildOwnerDelivery };
