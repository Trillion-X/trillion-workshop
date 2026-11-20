#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/decode-addressed-exchange.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Leaf decode capability for the chat package's OWN live-conversation store: the
# addressed-exchange conversation-ledger (records written by
# do-work/write-addressed-exchange-ledger.ts at
# `package::chat::conversation-ledger::{index,conversation::<id>,turn::<id>}`).
#
# It is the addressed-record analogue of `decode-jsonl-session` (which decodes
# file-based CLI logs): given ONE observation carrying a ledger conversation +
# its turns INLINE, it emits the SAME canonical content-atom contract — a thread
# record (what the sidebar conversation list reads) + ordered atoms (what the
# transcript view reads). `materialize-conversations.py` composes this exactly
# like any other decoder, so a live chat folds into `chat-session-window`
# alongside the imported CLI transcripts — one generic window, all sources.
#
# WHY INLINE (not a file/observer): the ledger lives in engine addressed-records,
# which a sandboxed compute.process cannot read. So the WORKFLOW reads the ledger
# records (engine read steps) and hands each conversation to this decoder as the
# observation payload. This decoder owns ONLY the ledger-shape knowledge (L098);
# it is blind to model/provider names and adds zero branches per agent (L090).
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. Output is EXACTLY the {threads, atoms, rejections} + thread shape that
#    decode-jsonl-session emits and materialize-conversations.py consumes.
# 2. Per-turn speaker carries the turn's participantRef/modelRef — this is the
#    per-turn agent attribution that the conversation header (#57) reads to show
#    who participated + who spoke last (model can change mid-conversation).
# 3. Pure transform: file/stdin in -> file out. No engine reads, no network.
# 4. No format branches on model/provider: role drives kind, nothing else.
#
# =============================================================================
# CLI (compute.process), mirrors decode-jsonl-session:
#   decode-addressed-exchange.py <request.json> <out.json>
#     request = {"observation": <obs>, "descriptor": {...}}
#             | {"batch": {"accepted": [<obs>, ...]}, "descriptor": {...}}
#   obs = {"source_ref": "live-chat", "observed_at": <iso>, "batch_ref": <ref>,
#          "conversation": {"conversationId","title",...},
#          "turns": [{"turnId","role","content","at"?,
#                     "participantRef"?,"modelRef"?}, ...]}
# =============================================================================
import datetime
import json
import pathlib
import sys

# The BLAKE3 identity is the one owner's (tools/conversations/read-data/content_identity.py), loaded from there at its
# declared path, never copied beside this script.
import importlib.util
_OWNER = pathlib.Path(__file__).resolve().parents[5] / "conversations" / "read-data" / "content_identity.py"
_spec = importlib.util.spec_from_file_location("content_identity", _OWNER)
_content_identity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_content_identity)
multihash_hex = _content_identity.content_hash

PREVIEW_CHARS = 240


def normalize_ts(value):
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)) and value > 0:
        try:
            return datetime.datetime.fromtimestamp(
                value / 1000 if value > 1e12 else value, datetime.timezone.utc
            ).isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return None
    return None


def first_text(content):
    """Plain text from a string, a content-block list, or a block dict."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    if isinstance(content, dict):
        text = content.get("text") or content.get("content")
        if isinstance(text, str):
            return text
    return ""


# Role -> atom kind. The ledger role is the ONLY discriminant; no model/provider
# branch. Unknown roles fall back to a plain utterance so a new role never breaks
# rendering (and never needs an edit here).
def kind_for_role(role: str) -> str:
    r = (role or "").lower()
    if r in ("tool", "tool_use", "tool-call"):
        return "tool-call"
    if r in ("tool_result", "tool-result"):
        return "tool-result"
    if r in ("system", "status"):
        return "status"
    if r in ("thinking", "thought", "reasoning"):
        return "thought"
    return "utterance"


def speaker_for_turn(turn: dict, role: str) -> str:
    """The human/agent identity for this turn. participantRef/modelRef carry the
    per-turn attribution (#57: who spoke, since the model can change mid-chat)."""
    return (
        turn.get("participantRef")
        or turn.get("modelRef")
        or turn.get("model")
        or role
        or "assistant"
    )


def emit(atoms, thread_ref, source_ref, batch_ref, kind, at, text, speaker, tool=None, *, turn_ref):
    """Append one self-describing atom — identical shape to decode-jsonl-session."""
    locator = [thread_ref, ["native", str(turn_ref)]]
    identity = multihash_hex(json.dumps(locator, ensure_ascii=False, separators=(",", ":")).encode())
    atom = {
        "atom_ref": f"atom:{identity}",
        "source_locator": locator,
        "thread_ref": thread_ref,
        "kind": kind,
        "speaker_ref": f"speaker:{source_ref}:{speaker}",
        "at": at,
        "content": {"text": text or ""},
        "relations": [],
        "source_ref": source_ref,
        "observation_refs": [batch_ref] if batch_ref else [],
    }
    if tool is not None:
        atom["tool"] = tool
    atom["content_revision"] = multihash_hex(json.dumps(
        {key: atom.get(key) for key in ("kind", "speaker_ref", "at", "content", "tool")},
        sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())
    atoms.append(atom)


def decode_one(observation, descriptor):
    source_ref = observation.get("source_ref") or "live-chat"
    conversation = observation.get("conversation") or {}
    turns = observation.get("turns") or []
    convo_id = conversation.get("conversationId") or conversation.get("id")
    if not convo_id:
        return {"thread": None, "atoms": [],
                "rejection": {"source_ref": source_ref, "violation_path": "conversation.conversationId",
                              "expected": "non-empty", "got": "missing"}}

    thread_ref = f"thread:{source_ref}:{convo_id}"
    batch_ref = observation.get("batch_ref")
    atoms = []
    title = None

    for turn in turns if isinstance(turns, list) else []:
        if not isinstance(turn, dict):
            continue
        turn_ref = turn.get("turnId") or turn.get("id")
        if not isinstance(turn_ref, str) or not turn_ref.strip():
            return {"thread": None, "atoms": [], "rejection": {
                "source_ref": source_ref, "violation_path": "turns.turnId",
                "expected": "durable turn identity", "got": "missing"}}
        role = turn.get("role") or "assistant"
        kind = kind_for_role(role)
        text = first_text(turn.get("content"))
        at = normalize_ts(turn.get("at") or turn.get("timestamp") or turn.get("created_at"))
        speaker = speaker_for_turn(turn, role)
        tool = turn.get("tool") if isinstance(turn.get("tool"), dict) else None
        emit(atoms, thread_ref, source_ref, batch_ref, kind, at, text, speaker, tool=tool, turn_ref=turn_ref)
        # First human line is the conversation title (mirrors the CLI decoder).
        if title is None and kind == "utterance" and role.lower() == "user" and text and not text.lstrip().startswith("<"):
            title = text.strip()[:PREVIEW_CHARS]

    utterances = [a for a in atoms if a["kind"] == "utterance"]
    timestamps = [a.get("at") for a in atoms if a.get("at")]
    last_text = utterances[-1]["content"]["text"][:PREVIEW_CHARS] if utterances else None
    thread = {
        "thread_ref": thread_ref,
        "session_id": convo_id,
        "source_ref": source_ref,
        "native_ref": f"ledger:{convo_id}",
        "presentation": {
            "mark_ref": descriptor.get("display_mark_ref"),
            "title": title or conversation.get("title") or convo_id,
            "subtitle": last_text,
            "at": (timestamps[-1] if timestamps else None) or normalize_ts(conversation.get("lastActivityAt") or conversation.get("startedAt")) or observation.get("observed_at"),
        },
        "atom_count": len(utterances),
        "started_at": (timestamps[0] if timestamps else None) or normalize_ts(conversation.get("startedAt")),
        "last_activity_at": (timestamps[-1] if timestamps else None) or normalize_ts(conversation.get("lastActivityAt")),
    }
    return {"thread": thread, "atoms": atoms}


def decode(observation, descriptor):
    """Uniform decoder entrypoint: one observation -> {threads, atoms, rejections}."""
    result = decode_one(observation, descriptor)
    thread = result.get("thread")
    return {
        "threads": [thread] if thread else [],
        "atoms": result.get("atoms", []),
        "rejections": [result["rejection"]] if result.get("rejection") else [],
    }


def main():
    request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = sys.argv[2]
    descriptor = request.get("descriptor") or {}
    if "observation" in request:
        results = [decode_one(request["observation"], descriptor)]
    else:
        batch = request.get("batch") or {}
        observations = batch.get("accepted") or batch.get("observations") or []
        results = [decode_one(o, descriptor) for o in observations if isinstance(o, dict)]
    threads = [r["thread"] for r in results if r.get("thread")]
    rejections = [r["rejection"] for r in results if r.get("rejection")]
    all_atoms = [a for r in results for a in r.get("atoms", [])]
    pathlib.Path(out_path).write_text(json.dumps({
        "threads": threads, "atoms": all_atoms, "rejections": rejections,
    }, separators=(",", ":")), encoding="utf-8")
    print(f"threads={len(threads)} atoms={len(all_atoms)} rejections={len(rejections)}")


if __name__ == "__main__":
    main()
