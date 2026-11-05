#!/usr/bin/env python3
"""Greedily pack complete ordered section blocks under the serving tokenizer limit.

This is DATA preparation only. It calls the maintained requestPlan for exact
request composition and the pinned Decider tokenizer/prompt builder for sizing;
it never sends inference requests.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

# The decider prompt package is in the folder the caller names (--decider-dir, the pinned model snapshot); a test puts
# stand-ins for it and for transformers in sys.modules first.
for _index, _word in enumerate(sys.argv):
    if _word == "--decider-dir" and _index + 1 < len(sys.argv):
        sys.path.insert(0, str(Path(sys.argv[_index + 1]).resolve()))
from transformers import AutoTokenizer
from decider.systemone import render_question, plan_rows
from decider.prompt import build
from decider.infer import Example, Q


LIMIT = 4096
PACK_TARGET = 3600


def maintained_plans(data: dict, module: Path, *, include_all: bool = False) -> dict:
    script = r'''
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const m=await import(pathToFileURL(process.argv[1]).href);
const data=JSON.parse(readFileSync(0,'utf8'));
const mode=data.items.every(item=>item.split==='unlabeled')?'unlabeled':'evaluation';
m.validateInput(data,{mode});
const includeAll=process.argv[2]==='true';
const selected=includeAll?data.items:data.items.filter(item=>item.section_chunk_manifest);
const plans=Object.fromEntries(selected
  .map(item=>[item.id,m.requestPlan(data,item)]));
process.stdout.write(JSON.stringify(plans));
'''
    result = subprocess.run(["node", "--input-type=module", "-e", script, str(module), str(include_all).lower()],
                            input=json.dumps(data, ensure_ascii=False), text=True,
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def row_tokens(tokenizer, content: str, criterion_id: str, question: str,
               options: list[object], keep) -> int:
    labels = {option if isinstance(option, str) else option["name"]:
              None if isinstance(option, str) else option.get("description")
              for option in options}
    rendered = render_question({"type": "choice", "instructions": question, "criteria": labels})
    rows, _ = plan_rows({criterion_id: rendered}, False)
    built = build(Example(content, [Q(rows[0]["question"], rows[0]["options"], 0)]),
                  tokenizer, keep, max_ctx_tokens=LIMIT + 1, layout="state_first")
    return len(built["ids"])


def criterion_row_tokens(tokenizer, content: str, criterion_id: str,
                         request: dict, keep) -> int:
    shape = request["shape"]
    if shape.get("kind") == "true-or-false":
        means = shape.get("means") or {}
        rendered = render_question({
            "type": "noul", "instructions": request["question"],
            "criteria": {"true": means.get("yes"), "false": means.get("no")},
        })
    elif shape.get("kind") == "one-of":
        labels = {option if isinstance(option, str) else option["name"]:
                  None if isinstance(option, str) else option.get("description")
                  for option in shape["options"]}
        rendered = render_question({
            "type": "choice", "instructions": request["question"], "criteria": labels,
        })
    else:
        raise ValueError(f"Unsupported request primitive for {criterion_id}")
    rows, _ = plan_rows({criterion_id: rendered}, False)
    state_ids = tokenizer.encode("Context:\n" + content, add_special_tokens=False)
    if len(state_ids) > LIMIT + 1:
        raise ValueError(f"Complete state for {criterion_id} exceeds the {LIMIT}-token bound")
    built = build(Example(content, [Q(rows[0]["question"], rows[0]["options"], 0)]),
                  tokenizer, keep, max_ctx_tokens=LIMIT + 1, layout="state_first")
    if built["ids"][:len(state_ids)] != state_ids:
        raise ValueError(f"Prompt construction truncated the complete state for {criterion_id}")
    tokens = len(built["ids"])
    if tokens > LIMIT:
        raise ValueError(f"Complete composed request for {criterion_id} is {tokens} tokens; limit is {LIMIT}")
    return tokens


def collect_token_requests(data: dict, plans: dict) -> list[tuple[str, str, str, dict]]:
    """Return all maintained criterion requests, including section chunks."""
    requests = []
    for item in data["items"]:
        plan = plans.get(item["id"])
        if plan is None:
            raise ValueError(f"Maintained requestPlan omitted {item['id']}")
        if plan.get("asking"):
            for criterion_id, request in plan["asking"].items():
                requests.append((item["id"], criterion_id, plan["content"], request))
        for chunk in plan.get("chunk_requests", []):
            for criterion_id, request in chunk["asking"].items():
                requests.append((item["id"], criterion_id, chunk["content"], request))
    if not requests:
        raise ValueError("Maintained requestPlan produced no criterion requests")
    return requests


class KeepFirst:
    def shuffle(self, values):
        return None

    def sample(self, values, count):
        return values[:count]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--tokenizer-model-dir", required=True, type=Path)
    parser.add_argument("--decider-dir", type=Path, help="folder holding the decider prompt package (the model snapshot)")
    parser.add_argument("--target-tokens", type=int, default=PACK_TARGET)
    parser.add_argument("--tokens-only", action="store_true",
                        help="validate and size all v3 requests without editing DATA or packing sections")
    args = parser.parse_args()
    if not 1 <= args.target_tokens < LIMIT:
        parser.error(f"--target-tokens must be between 1 and {LIMIT - 1}")
    data = json.loads(args.data.read_text())
    module = Path(__file__).resolve().parent.parent.joinpath("read-data", "evaluation-integrity.mjs")
    plans = maintained_plans(data, module, include_all=args.tokens_only)
    tokenizer = AutoTokenizer.from_pretrained(str(args.tokenizer_model_dir))
    keep = KeepFirst()
    if args.tokens_only:
        if args.out.exists():
            raise ValueError("Output already exists; choose a new private report path")
        measured = collect_token_requests(data, plans)
        counts = []
        for item_id, criterion_id, content, request in measured:
            counts.append({"id": item_id, "criterion_id": criterion_id,
                           "composed_tokens": criterion_row_tokens(tokenizer, content, criterion_id, request, keep)})
        args.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        report = {"schema": "book-voice-request-tokenizer-preflight-v1", "status": "passed",
                  "data": str(args.data.resolve()), "tokenizer_model_dir": str(args.tokenizer_model_dir.resolve()),
                  "data_blake3": subprocess.check_output(["b3sum", "--no-names", str(args.data.resolve())],
                                                         text=True, timeout=120).strip(),
                  "input_limit": LIMIT, "items": len(data["items"]), "criterion_requests": len(counts),
                  "max_complete_composed_tokens": max(row["composed_tokens"] for row in counts),
                  "counts": counts, "model_loaded": False, "inference": False,
                  "model_calls_made": False, "request_sent": False,
                  "method": "Maintained validateInput + requestPlan, pinned AutoTokenizer and decider.prompt.build; DATA is read-only."}
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        args.out.chmod(0o600)
        print(json.dumps({"status": report["status"], "items": report["items"],
                          "criterion_requests": report["criterion_requests"],
                          "max_tokens": report["max_complete_composed_tokens"],
                          "input_limit": LIMIT, "model_calls_made": False, "request_sent": False}))
        return 0

    before = after = 0
    items_by_index = {item["source_block_index"]: item for item in data["items"]}

    for item in data["items"]:
        manifest = item.get("section_chunk_manifest")
        if manifest is None:
            continue
        plan = plans.get(item["id"])
        if not plan or not plan.get("chunk_requests"):
            raise ValueError(f"Maintained requestPlan produced no local chunk request for {item['id']}")
        template = json.loads(plan["chunk_requests"][0]["content"])
        chunk_state = template["section_chunk"]
        criterion_id, request = next(iter(plan["chunk_requests"][0]["asking"].items()))
        options = request["shape"]["options"]
        question = request["question"]
        source_indices = list(range(item["source_block_index"] + 1,
                                    manifest["section_end_block_index"]))
        old_chunks = manifest["chunks"]
        before += len(old_chunks)
        groups: list[list[int]] = []
        current: list[int] = []

        def render(indices: list[int], chunk_index: int) -> str:
            state = json.loads(json.dumps(template))
            state["section_chunk"].update({
                "chunk_index": chunk_index,
                "chunk_count": max(1, len(source_indices)),
                "block_indices": indices,
                "text": "\n\n".join(items_by_index[index]["text"] for index in indices),
            })
            return json.dumps(state, ensure_ascii=False, separators=(",", ":"))

        for index in source_indices:
            candidate = current + [index]
            candidate_tokens = row_tokens(tokenizer, render(candidate, len(groups)),
                                          criterion_id, question, options, keep)
            if candidate_tokens > args.target_tokens and current:
                groups.append(current)
                current = [index]
                singleton_tokens = row_tokens(tokenizer, render(current, len(groups)),
                                              criterion_id, question, options, keep)
                if singleton_tokens > LIMIT:
                    raise ValueError(f"Single source block exceeds {LIMIT} tokens: {item['id']}:{index}")
            else:
                if candidate_tokens > LIMIT:
                    raise ValueError(f"Single source block exceeds {LIMIT} tokens: {item['id']}:{index}")
                current = candidate
        if current:
            groups.append(current)
        manifest["chunks"] = [
            {"chunk_index": index, "block_indices": indices,
             "text": "\n\n".join(items_by_index[source_index]["text"] for source_index in indices)}
            for index, indices in enumerate(groups)
        ]
        after += len(groups)

    final_plans = maintained_plans(data, module)
    final_count = 0
    max_final = 0
    for plan in final_plans.values():
        for chunk in plan["chunk_requests"]:
            criterion_id, request = next(iter(chunk["asking"].items()))
            tokens = row_tokens(tokenizer, chunk["content"], criterion_id,
                                request["question"], request["shape"]["options"], keep)
            final_count += 1
            max_final = max(max_final, tokens)
            if tokens > LIMIT:
                raise ValueError(f"Final section chunk exceeds {LIMIT} tokens")
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    args.out.chmod(0o600)
    print(json.dumps({"schema": "section-chunk-packing-run-v1", "headings": len(plans),
                      "chunks_before": before, "chunks_after": after,
                      "final_chunk_requests": final_count, "max_final_tokens": max_final,
                      "target_tokens": args.target_tokens, "limit": LIMIT,
                      "model_calls_made": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"section chunk packing failed closed: {error}", file=sys.stderr)
        raise SystemExit(1)
