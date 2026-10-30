// tools/cross-techniques-with-a-goal/do-work/meaning.mjs
//
// Purpose
//   The two model calls every step of this folder makes, and the one comparison: `embedder` turns texts into unit
//   vectors (closeness in meaning), `writer` asks a chat model for JSON that a schema shapes, and `cosine` compares
//   two vectors. Both speak the OpenAI-compatible HTTP shape (`/embeddings`, `/chat/completions`), which a model on
//   the person's own computer (Ollama, llama.cpp, LM Studio) and rented runtimes all serve, so no provider is named.
//
// Non-negotiable invariants
//   1. A model is DATA the caller hands in: `{ url, model }`, where url is the OpenAI-compatible base ending before
//      `/embeddings` or `/chat/completions`. A caller that needs a key names the environment variable that holds it
//      (`key_env`); the key itself never travels in a request.
//   2. Every vector leaves `embedder` cut to `dims` (Matryoshka models keep meaning in their leading dimensions) and
//      scaled to unit length, so `cosine` of two of them is their dot product. Vectors made by different models, dims
//      or forms are never compared: `sameMeaning` says whether two vector owners match.
//   3. Texts are wrapped in the model's own form before embedding (`forms.query`, `forms.document`; `{text}` and
//      `{title}` are the slots), because an embedding model reads a query and a document differently.
//   4. `writer` asks for one JSON object shaped by a JSON Schema, at temperature 0 and a fixed seed, and returns it
//      parsed. Text that does not parse is an error that says which model answered what.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const trimSlash = url => url.replace(/\/+$/, '');

const headers = model => {
  const key = model.key_env ? process.env[model.key_env] : undefined;
  if (model.key_env && !key) throw new Error(`The model at ${model.url} needs the key in environment variable ${model.key_env}, which is not set. Set it, or name the variable that holds the key.`);
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
};

async function post(model, path, body) {
  const url = `${trimSlash(model.url)}${path}`;
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: headers(model), body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(`Could not reach the model at ${url} (${error.cause?.code ?? error.message}). Start the model server, or give another url.`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`The model at ${url} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export const fill = (form, slots) => form.replace(/\{(\w+)\}/g, (_, name) => slots[name] ?? 'none');

export const unit = (vector, dims = vector.length) => {
  const cut = vector.slice(0, dims);
  const length = Math.sqrt(cut.reduce((sum, value) => sum + value * value, 0)) || 1;
  return cut.map(value => value / length);
};

// Unit vectors: the dot product is the cosine.
export const cosine = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
};

// Rounded for storage as DATA: four decimals keep every cosine within 0.001 of the exact one.
export const kept = vector => vector.map(value => Math.round(value * 1e4) / 1e4);

// What a vector was made by: the model, the dims it was cut to and the forms texts were wrapped in.
export const meaningOf = meaning => ({ model: meaning.model, dims: meaning.dims, forms: meaning.forms });
export const sameMeaning = (one, other) => Boolean(one && other) && one.model === other.model && one.dims === other.dims
  && JSON.stringify(one.forms) === JSON.stringify(other.forms);

// (meaning) -> { meaning: { model, dims }, texts: async (texts, form, slots?) -> unit vectors }. `form` is a key of
// meaning.forms; each text fills {text}, and slots[i] fills the other slots of text i.
export function embedder(meaning) {
  if (!meaning?.url || !meaning?.model || !meaning?.dims || !meaning?.forms) {
    throw new Error('meaning needs { url, model, dims, forms: { query, document } }: the embedding model and how it reads a query and a document.');
  }
  const batch = meaning.batch ?? 64;
  return { meaning: meaningOf(meaning), texts: async (texts, form, slots = []) => {
    const template = meaning.forms[form];
    if (!template) throw new Error(`meaning.forms has no form "${form}"; give one with {text} where the words go.`);
    const wrapped = texts.map((text, index) => fill(template, { ...(slots[index] ?? {}), text }));
    const vectors = [];
    for (let start = 0; start < wrapped.length; start += batch) {
      const answer = await post(meaning, '/embeddings', { model: meaning.model, input: wrapped.slice(start, start + batch) });
      const data = [...answer.data].sort((a, b) => a.index - b.index);
      vectors.push(...data.map(item => unit(item.embedding, meaning.dims)));
    }
    return vectors;
  } };
}

// (writing) -> async ({ system, examples?, user, schema, name }) -> the parsed JSON object the schema shapes. Each
// example { user, answer } becomes a worked turn before the real one; user and answer may be JSON values.
const said = value => (typeof value === 'string' ? value : JSON.stringify(value));
export function writer(writing) {
  if (!writing?.url || !writing?.model) throw new Error('writing needs { url, model }: the chat model that writes the JSON.');
  return async ({ system, examples = [], user, schema, name }) => {
    const answer = await post(writing, '/chat/completions', {
      model: writing.model,
      temperature: 0,
      seed: writing.seed ?? 7,
      ...(writing.max_tokens ? { max_tokens: writing.max_tokens } : {}),
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      messages: [
        { role: 'system', content: system },
        ...examples.flatMap(example => [{ role: 'user', content: said(example.user) }, { role: 'assistant', content: said(example.answer) }]),
        { role: 'user', content: said(user) },
      ],
    });
    const text = answer.choices?.[0]?.message?.content ?? '';
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${writing.model} answered text that is not JSON: ${text.slice(0, 300)}`);
    }
  };
}
