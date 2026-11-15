#!/usr/bin/env node
// Generic single-or-batch text-embedding executor over Ollama.
//
// Node port of embed-text-ollama.py (L108 preserve-behavior). The
// semantic-index-descriptor's executor.argv names this leaf + flags:
//   --request-json  request.json   (text at content_text/query_text, or batch
//                                   items at [{"id":"...","text":"..."}])
//   --output-json   embedding.json (single {"vector":[...],...} or batch
//                                   {"vectors":{"id":[...]},...})
//   --model         <model name>   (DATA from the descriptor argv, never baked)
//   --endpoint      <base url>     (default http://localhost:11434)
// Fail-closed: missing/empty text or a non-numeric vector exits non-zero with a
// stderr message; it never emits a fabricated vector.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pyDumps, pyFloat } from "./pyjson.mjs";
import { ValueError } from "./canonical_multihash.mjs";

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Python: all(isinstance(item,(int,float)) and not isinstance(item,bool)). Returns
// [float(item)] so integer-valued elements render "N.0"; wrap each in pyFloat.
function numericVector(value, label) {
  const ok =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
  if (!ok) {
    throw new ValueError(`${label} must be a non-empty numeric vector`);
  }
  return value.map((item) => pyFloat(item));
}

// Returns null for single-mode (no "items" key), else validated [id,text] pairs.
function batchItems(request) {
  const rawItems = request.items;
  if (rawItems === undefined || rawItems === null) {
    return null;
  }
  if (!Array.isArray(rawItems)) {
    throw new ValueError("batch items must be an array");
  }
  const items = [];
  const seen = new Set();
  for (const raw of rawItems) {
    if (!isDict(raw)) {
      throw new ValueError("each batch item must be an object");
    }
    const itemId = raw.id;
    const text = raw.text;
    if (typeof itemId !== "string" || !itemId) {
      throw new ValueError("each batch item requires a non-empty string id");
    }
    if (seen.has(itemId)) {
      throw new ValueError(`duplicate batch item id: ${itemId}`);
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new ValueError(`batch item '${itemId}' requires non-empty text`);
    }
    seen.add(itemId);
    items.push([itemId, text]);
  }
  return items;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body), "utf-8");
    const req = transport.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length }, timeout: 120000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (!isDict(reply)) {
              reject(new ValueError("embedding endpoint response must be an object"));
              return;
            }
            resolve(reply);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function parseArgs(argv, spec, defaults) {
  const values = { ...defaults };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    let matched = false;
    for (const [dest, flag] of Object.entries(spec)) {
      if (token === flag) {
        values[dest] = argv[i + 1];
        i += 2;
        matched = true;
        break;
      }
      if (token.startsWith(flag + "=")) {
        values[dest] = token.slice(flag.length + 1);
        i += 1;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  return values;
}

function rstripSlash(value) {
  return value.replace(/\/+$/, "");
}

async function main() {
  const args = parseArgs(
    process.argv.slice(2),
    {
      request_json: "--request-json",
      output_json: "--output-json",
      model: "--model",
      endpoint: "--endpoint",
    },
    { endpoint: "http://localhost:11434" },
  );

  const request = JSON.parse(fs.readFileSync(args.request_json, "utf-8"));
  if (!isDict(request)) {
    process.stderr.write("[embed-text-ollama] request must be a JSON object\n");
    return 1;
  }

  const provenance = { model_id: args.model, model_version: "ollama" };
  let items;
  try {
    items = batchItems(request);
  } catch (error) {
    if (error instanceof ValueError) {
      process.stderr.write(`[embed-text-ollama] ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (items !== null) {
    let output;
    if (items.length === 0) {
      output = { vectors: {}, provenance };
    } else {
      try {
        const reply = await postJson(`${rstripSlash(args.endpoint)}/api/embed`, {
          model: args.model,
          input: items.map(([, text]) => text),
        });
        const embeddings = reply.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== items.length) {
          throw new ValueError("endpoint embeddings count does not match batch item count");
        }
        const vectors = {};
        for (let idx = 0; idx < items.length; idx++) {
          const [itemId] = items[idx];
          vectors[itemId] = numericVector(embeddings[idx], `embedding for '${itemId}'`);
        }
        output = { vectors, provenance };
      } catch (error) {
        if (error instanceof ValueError) {
          process.stderr.write(`[embed-text-ollama] ${error.message}\n`);
          return 1;
        }
        throw error;
      }
    }
    fs.writeFileSync(args.output_json, pyDumps(output, { ensureAscii: true }), "utf-8");
    process.stdout.write(`[embed-text-ollama] embedded ${items.length} batch items via ${args.model}\n`);
    return 0;
  }

  const text = request.content_text || request.query_text || "";
  if (typeof text !== "string" || text.trim() === "") {
    process.stderr.write("[embed-text-ollama] no content_text/query_text in request\n");
    return 1;
  }

  const reply = await postJson(`${rstripSlash(args.endpoint)}/api/embeddings`, {
    model: args.model,
    prompt: text,
  });
  let vector;
  try {
    vector = numericVector(reply.embedding, "endpoint embedding");
  } catch (error) {
    if (error instanceof ValueError) {
      const keys = Object.keys(reply).sort();
      process.stderr.write(`[embed-text-ollama] endpoint returned no numeric embedding: keys=${pyDumps(keys, { ensureAscii: false })}\n`);
      return 1;
    }
    throw error;
  }

  const output = { vector, provenance };
  fs.writeFileSync(args.output_json, pyDumps(output, { ensureAscii: true }), "utf-8");
  process.stdout.write(`[embed-text-ollama] embedded ${text.length} chars -> ${vector.length} dims via ${args.model}\n`);
  return 0;
}

main().then((code) => process.exit(code));
