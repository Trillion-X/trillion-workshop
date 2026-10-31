#!/usr/bin/env node
// Generic DATA-driven instruction assembler. It owns no domain vocabulary and
// never invokes a provider; it returns the instruction an AI writes from.

const asString = (value) => (typeof value === "string" ? value : "");
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readJsonArg(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function groundingIsPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (plainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function renderSchema(recipe) {
  const contract = plainObject(recipe.output_contract) ? recipe.output_contract : {};
  const schema = contract.schema;
  if (typeof schema === "string") return schema;
  if (schema == null) return "";
  return JSON.stringify(schema, null, 2);
}

function renderGrounding(value, label) {
  if (!groundingIsPresent(value)) return "";
  const body = (() => { try { return JSON.stringify(value); } catch { return ""; } })();
  return [label, body].filter(Boolean).join("\n");
}

function renderSegments(segments, context) {
  if (!Array.isArray(segments)) return "";
  const rendered = segments.map((segment) => renderSegment(segment, context));
  return rendered.filter((part) => part !== "").join("\n");
}

function renderSegment(segment, context) {
  if (typeof segment === "string") return segment;
  if (!plainObject(segment)) return "";

  const blockRef = asString(segment.block_ref);
  if (blockRef) {
    if (!context.blocksById.has(blockRef)) throw new Error(`instruction block is unavailable: ${blockRef}`);
    return context.blocksById.get(blockRef);
  }
  if (typeof segment.literal === "string") return segment.literal;
  // One line made of parts, joined with nothing between them, so a value can sit inside a sentence.
  if (Array.isArray(segment.line)) return segment.line.map((part) => renderSegment(part, context)).join("");

  const slot = asString(segment.slot);
  if (slot === "work_item") {
    const value = segment.path ? context.workItem[asString(segment.path)] : undefined;
    if (typeof value === "string") return value.trim();
    if (value == null) return "";
    return JSON.stringify(value);
  }
  if (slot === "schema") return renderSchema(context.recipe);
  if (slot === "grounding") return renderGrounding(context.grounding, asString(segment.label));
  if (slot === "conditional_grounding") {
    const branch = groundingIsPresent(context.grounding) ? segment.when_present : segment.when_absent;
    return renderSegments(branch, context);
  }
  if (slot === "conditional_value") {
    const key = asString(segment.path);
    const branch = Boolean(key && context.workItem[key]) ? segment.when_present : segment.when_absent;
    return renderSegments(branch, context);
  }
  return "";
}

function indexBlocks(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const payload = plainObject(row?.payload) ? row.payload : row;
    if (!plainObject(payload) || payload.kind !== "ai-instruction-block") continue;
    const id = asString(payload.id);
    if (id && typeof payload.body === "string") out.set(id, payload.body);
  }
  return out;
}

export function composeRunRequest({recipe, workItem, grounding = [], blocks = [], requestId = ''}) {
  if (!plainObject(recipe) || !plainObject(workItem)) throw new TypeError('recipe and work item are required');
  const plan = plainObject(recipe.instruction_plan) ? recipe.instruction_plan : {};
  const instructionText = renderSegments(plan.prompt_template, {
    recipe, workItem, grounding, blocksById: indexBlocks(blocks),
  });
  const producer = plainObject(recipe.ai_producer_target) ? recipe.ai_producer_target : {};
  const request = {
    input_refs: [], instruction_text: instructionText,
    output_kind: asString(producer.output_kind) || 'note',
    request_id: asString(requestId) || asString(workItem.request_id),
  };
  const inputRefsField = asString(recipe.context_retrieval?.input_refs_field);
  if (inputRefsField) {
    const refs = workItem[inputRefsField];
    if (!Array.isArray(refs) || refs.length === 0) throw new Error('Saved evidence references are required.');
    request.input_refs = refs;
  }
  for (const key of ['model', 'agent_ref']) {
    const value = asString(producer[key]);
    if (value) request[key] = value;
  }
  if (typeof producer.target_group_ref === 'string' && producer.target_group_ref) request.target_group_ref = producer.target_group_ref;
  if (plainObject(producer.parameters) && Object.keys(producer.parameters).length > 0) request.parameters = producer.parameters;
  return request;
}
