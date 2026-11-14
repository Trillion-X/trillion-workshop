#!/usr/bin/env python3
"""Generic single-or-batch text-embedding executor over Ollama.

Contract (the semantic-index-descriptor's executor.argv names this script + flags):
  --request-json  request.json   (mounted by meaning-search actions; text at
                                  content_text/query_text, or batch items at
                                  [{"id": "...", "text": "..."}])
  --output-json   embedding.json (single {"vector":[...],...} or batch
                                  {"vectors":{"id":[...]},...})
  --model         <model name>   (DATA — comes from the descriptor argv, never baked)
  --endpoint      <base url>     (default http://localhost:11434)

Fail-closed: missing/empty text or a non-numeric vector exits non-zero with a
stderr message; it never emits a fabricated vector.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request


def numeric_vector(value: object, label: str) -> list[float]:
    if not isinstance(value, list) or not value or not all(
            isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
        raise ValueError(f"{label} must be a non-empty numeric vector")
    return [float(item) for item in value]


def batch_items(request: dict) -> list[tuple[str, str]] | None:
    raw_items = request.get("items")
    if raw_items is None:
        return None
    if not isinstance(raw_items, list):
        raise ValueError("batch items must be an array")
    items: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("each batch item must be an object")
        item_id = raw.get("id")
        text = raw.get("text")
        if not isinstance(item_id, str) or not item_id:
            raise ValueError("each batch item requires a non-empty string id")
        if item_id in seen:
            raise ValueError(f"duplicate batch item id: {item_id}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"batch item {item_id!r} requires non-empty text")
        seen.add(item_id)
        items.append((item_id, text))
    return items


def post_json(url: str, body: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        reply = json.load(response)
    if not isinstance(reply, dict):
        raise ValueError("embedding endpoint response must be an object")
    return reply


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--endpoint", default="http://localhost:11434")
    args = parser.parse_args()

    with open(args.request_json, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    if not isinstance(request, dict):
        print("[embed-text-ollama] request must be a JSON object", file=sys.stderr)
        return 1

    provenance = {"model_id": args.model, "model_version": "ollama"}
    try:
        items = batch_items(request)
    except ValueError as error:
        print(f"[embed-text-ollama] {error}", file=sys.stderr)
        return 1
    if items is not None:
        if not items:
            output = {"vectors": {}, "provenance": provenance}
        else:
            try:
                reply = post_json(
                    f"{args.endpoint.rstrip('/')}/api/embed",
                    {"model": args.model, "input": [text for _, text in items]},
                )
                embeddings = reply.get("embeddings")
                if not isinstance(embeddings, list) or len(embeddings) != len(items):
                    raise ValueError(
                        "endpoint embeddings count does not match batch item count"
                    )
                vectors = {
                    item_id: numeric_vector(embedding, f"embedding for {item_id!r}")
                    for (item_id, _), embedding in zip(items, embeddings)
                }
            except ValueError as error:
                print(f"[embed-text-ollama] {error}", file=sys.stderr)
                return 1
            output = {"vectors": vectors, "provenance": provenance}
        with open(args.output_json, "w", encoding="utf-8") as handle:
            json.dump(output, handle, separators=(",", ":"))
        print(
            f"[embed-text-ollama] embedded {len(items)} batch items via {args.model}"
        )
        return 0

    text = request.get("content_text") or request.get("query_text") or ""
    if not isinstance(text, str) or text.strip() == "":
        print("[embed-text-ollama] no content_text/query_text in request", file=sys.stderr)
        return 1

    reply = post_json(
        f"{args.endpoint.rstrip('/')}/api/embeddings",
        {"model": args.model, "prompt": text},
    )
    try:
        vector = numeric_vector(reply.get("embedding"), "endpoint embedding")
    except ValueError:
        print(
            f"[embed-text-ollama] endpoint returned no numeric embedding: keys={sorted(reply)}",
            file=sys.stderr,
        )
        return 1

    output = {"vector": vector, "provenance": provenance}
    with open(args.output_json, "w", encoding="utf-8") as handle:
        json.dump(output, handle, separators=(",", ":"))
    print(f"[embed-text-ollama] embedded {len(text)} chars -> {len(vector)} dims via {args.model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
