# packages/ai-cli-conversations/do-work/process-scripts/read-ai-cli-conversations.py
#
# Native reader for local AI CLI transcript files. The script has two modes:
# - scan: emits metadata records without embedding transcript bodies
# - scan-needed: emits whether maintained feed bytes must be refreshed
# - session-window-from-feed: emits the bounded session list from chat-sessions RTBL bytes
# - session-window-from-facts: emits the bounded session list from current facts
# - session-window-live: emits the bounded live agent window from transcript-file recency (any executor)
# - transcript: emits the normalized message list for one transcript file
#
# The workflow owner mounts this file through compute.process as a CAS blob.

import base64
import datetime
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys
import tempfile
import time


TEXT_BLOCK_TYPES = {"text", "input_text", "output_text"}
CHAT_ROLES = {"user", "assistant"}
TOOL_CALL_TYPES = {"function_call", "custom_tool_call"}
TOOL_RESULT_TYPES = {"function_call_output", "custom_tool_call_output"}
SKIP_TYPES = {"attachment", "queue-operation", "file-history-snapshot"}
MAX_METADATA_TEXT_CHARS = 512
MAX_TRANSCRIPT_PAGE_MESSAGES = 256
TAIL_CURSOR_READ_BYTES = 1024 * 1024
TAIL_CURSOR_PREFIX_METADATA_LINES = 128
MAX_JSON_ARRAY_TRANSCRIPT_BYTES = 64 * 1024 * 1024
# Codex image-bearing turns can legitimately exceed 32 MiB because one JSONL
# event can embed several rendered-image payloads plus the accumulated context.
# Keep the parser bounded while admitting those otherwise-valid transcript rows.
MAX_JSONL_EVENT_BYTES = 128 * 1024 * 1024
TRANSCRIPT_SOURCE_PROPERTY = "prop:observed_content:conversation_source_descriptor"
CHAT_SESSION_FACT_FIELD_BY_PROPERTY = {
    "prop:chat_session:title": "title",
    "prop:chat_session:source_session_id": "session_id",
    "prop:chat_session:agent_id": "agent_id",
    "prop:chat_session:cli_id": "cli_id",
    "prop:chat_session:model": "model",
    "prop:chat_session:slug": "slug",
    "prop:chat_session:prompt": "prompt",
    "prop:chat_session:project_name": "project_name",
    "prop:chat_session:project_slug": "project_slug",
    "prop:chat_session:started_at": "started_at",
    "prop:chat_session:last_activity_at": "last_activity_at",
    "prop:chat_session:message_count": "message_count",
    "prop:chat_session:account_dir": "account_dir",
    "prop:chat_session:file_path": "file_path",
    "prop:chat_session:file_size_bytes": "file_size_bytes",
    "prop:chat_session:file_modified_at": "file_modified_at",
    "prop:chat_session:source_present": "source_present",
    "prop:chat_session:project_path": "project_path",
}
INTEGER_FACT_FIELDS = {"file_size_bytes", "message_count"}
BOOLEAN_FACT_FIELDS = {"source_present"}
CHAT_SESSION_TABLE_COLUMNS = (
    ("recordId", "non_empty_text"),
    ("sessionId", "text"),
    ("agentId", "text"),
    ("title", "text"),
    ("cliId", "text"),
    ("model", "text"),
    ("slug", "text"),
    ("prompt", "text"),
    ("projectName", "text"),
    ("projectSlug", "text"),
    ("startedAt", "text"),
    ("lastActivityAt", "text"),
    ("messageCount", "number"),
    ("accountDir", "text"),
    ("filePath", "text"),
    ("fileSizeBytes", "number"),
    ("fileModifiedAt", "text"),
    ("sourcePresent", "byte_boolean"),
    ("projectPath", "text"),
)
SESSION_TRANSCRIPT_TABLE_COLUMNS = (
    ("subject_id", "non_empty_text"),
    ("property_id", "non_empty_text"),
    ("value_json", "json"),
)


def iso_from_epoch(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_ts(value):
    if isinstance(value, str) and value:
        return value.replace("+00:00", "Z")
    return None


def trim_text(value, max_chars=None):
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    if max_chars is None or len(stripped) <= max_chars:
        return stripped
    if max_chars <= 3:
        return stripped[:max_chars]
    return stripped[: max_chars - 3].rstrip() + "..."


def first_text(value, max_chars=None):
    if isinstance(value, str):
        return trim_text(value, max_chars)
    if isinstance(value, list):
        parts = []
        used_chars = 0
        for item in value:
            text = None
            if isinstance(item, str):
                text = item
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
            clipped = trim_text(text)
            if clipped is None:
                continue
            if max_chars is None:
                parts.append(clipped)
                continue
            separator_chars = 1 if parts else 0
            remaining = max_chars - used_chars - separator_chars
            if remaining <= 0:
                break
            if len(clipped) > remaining:
                parts.append(trim_text(clipped, remaining))
                break
            parts.append(clipped)
            used_chars += len(clipped) + separator_chars
        joined = " ".join(parts)
        return joined or None
    if isinstance(value, dict):
        text = value.get("text") or value.get("content")
        return trim_text(text, max_chars)
    return None


def has_text(value):
    return first_text(value, max_chars=1) is not None


def normalize_usage(value):
    if not isinstance(value, dict):
        return None
    usage = {}
    for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
        number = value.get(key)
        if isinstance(number, (int, float)):
            usage[key] = number
    return usage or None


def parse_tool_input(value):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except Exception:
            return {"raw": value}
    return {}


def parse_tool_call_input(payload):
    if "arguments" in payload:
        return parse_tool_input(payload.get("arguments"))
    if "input" in payload:
        return parse_tool_input(payload.get("input"))
    return {}


def append_line(lines, kind, content, timestamp, role=None, tool_name=None, tool_input=None, tool_use_id=None, usage=None, hook_event=None, hook_name=None, source_offset=None, attachments=None):
    if kind != "hook_progress" and not isinstance(content, str):
        return 0
    collapsed = content.strip() if isinstance(content, str) else ""
    if kind != "hook_progress" and not collapsed:
        return 0
    line = {"type": kind}
    if collapsed:
        line["content"] = collapsed
    if timestamp:
        line["timestamp"] = timestamp
    if role:
        line["role"] = role
    if tool_name:
        line["toolName"] = tool_name
    if tool_input is not None:
        line["toolInput"] = tool_input
    if isinstance(tool_use_id, str) and tool_use_id:
        line["toolUseId"] = tool_use_id
    if usage is not None:
        line["usage"] = usage
    if isinstance(hook_event, str) and hook_event:
        line["hookEvent"] = hook_event
    if isinstance(hook_name, str) and hook_name:
        line["hookName"] = hook_name
    if isinstance(source_offset, int) and source_offset >= 0:
        line["_source_offset"] = source_offset
    if attachments:
        line["attachments"] = attachments
    if lines is not None:
        lines.append(line)
    return 1


class TranscriptWindowCollector:
    def __init__(self, start_index, limit):
        self.requested_start_index = start_index
        self.limit = max(1, min(int(limit), MAX_TRANSCRIPT_PAGE_MESSAGES))
        self.lines = []
        self.total_count = 0

    def append(self, line):
        line_index = self.total_count
        self.total_count += 1

        if self.requested_start_index < 0:
            self.lines.append(line)
            if len(self.lines) > self.limit:
                self.lines.pop(0)
            return

        if self.requested_start_index <= line_index < self.requested_start_index + self.limit:
            self.lines.append(line)

    def __iter__(self):
        return iter(self.lines)

    def __bool__(self):
        return True

    def resolved_start_index(self):
        if self.requested_start_index >= 0:
            return min(self.requested_start_index, self.total_count)
        return max(0, self.total_count - len(self.lines))


def normalize_content(lines, speaker, content, timestamp, usage=None, source_offset=None):
    role = "human" if speaker == "user" else "assistant"
    line_type = "user" if speaker == "user" else "assistant"
    usage_taken = False

    def take_usage():
        nonlocal usage_taken
        if usage_taken or usage is None:
            return None
        usage_taken = True
        return usage

    if isinstance(content, str):
        return append_line(lines, line_type, content, timestamp, role=role, usage=take_usage(), source_offset=source_offset)
    if not isinstance(content, list):
        return 0

    # The exact user-message manifest is occurrence-based, not block-based. A
    # Codex message with text plus an image is one human utterance with one
    # attachment, never two independent Requests. Keep transcript rendering's
    # per-block lines unchanged; only the occurrence spool uses this shape.
    if speaker == "user" and isinstance(lines, UserMessageSpool):
        text_parts = []
        attachments = []
        for index, block in enumerate(content):
            if isinstance(block, str) and block.strip():
                text_parts.append(block.strip())
            elif isinstance(block, dict):
                block_type = block.get("type")
                if block_type in TEXT_BLOCK_TYPES:
                    value = block.get("text") or block.get("content")
                    if isinstance(value, str) and value.strip():
                        text_parts.append(value.strip())
                elif block_type in {"image", "input_image", "image_url"}:
                    attachments.append({"kind": "image", "source_block_index": index})
        merged = "\n".join(text_parts) or ("[Image attachment]" if attachments else "")
        return append_line(lines, line_type, merged, timestamp, role=role,
                           usage=take_usage(), source_offset=source_offset,
                           attachments=attachments)

    count = 0
    for block in content:
        if isinstance(block, str):
            count += append_line(lines, line_type, block, timestamp, role=role, usage=take_usage(), source_offset=source_offset)
            continue
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type in TEXT_BLOCK_TYPES:
            count += append_line(lines, line_type, block.get("text") or block.get("content", ""), timestamp, role=role, usage=take_usage(), source_offset=source_offset)
        elif block_type == "thinking":
            count += append_line(lines, "thinking", block.get("thinking", "") or block.get("text", ""), timestamp, role="assistant", usage=take_usage(), source_offset=source_offset)
        elif block_type == "tool_use":
            tool_name = block.get("name") if isinstance(block.get("name"), str) else "Tool"
            tool_input = block.get("input") if isinstance(block.get("input"), (dict, list)) else {}
            content_text = json.dumps(tool_input, ensure_ascii=False, sort_keys=True) if tool_input else tool_name
            count += append_line(lines, "tool_use", content_text, timestamp, role="assistant", tool_name=tool_name, tool_input=tool_input, tool_use_id=block.get("id"), usage=take_usage(), source_offset=source_offset)
        elif block_type == "tool_result":
            content_text = first_text(block.get("content"))
            if content_text is None and block.get("content") is not None:
                content_text = json.dumps(block.get("content"), ensure_ascii=False)
            count += append_line(lines, "tool_result", content_text or "", timestamp, role="assistant", tool_use_id=block.get("tool_use_id"), usage=take_usage(), source_offset=source_offset)
        elif block_type in {"image", "input_image", "image_url"}:
            count += append_line(lines, line_type, "[Image attachment]", timestamp, role=role, usage=take_usage(), source_offset=source_offset)
    return count


def count_content_units(content):
    if isinstance(content, str):
        return 1 if content.strip() else 0
    if not isinstance(content, list):
        return 0

    count = 0
    for block in content:
        if isinstance(block, str):
            count += 1 if block.strip() else 0
            continue
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type in TEXT_BLOCK_TYPES:
            count += 1 if has_text(block.get("text") or block.get("content")) else 0
        elif block_type == "thinking":
            count += 1 if has_text(block.get("thinking") or block.get("text")) else 0
        elif block_type == "tool_use":
            count += 1
        elif block_type == "tool_result":
            count += 1 if block.get("content") is not None else 0
        elif block_type in {"image", "input_image", "image_url"}:
            count += 1
    return count


def extract_progress_prompt(data, max_chars=None):
    prompt = data.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return trim_text(prompt, max_chars)
    message = data.get("message")
    if isinstance(message, dict):
        nested = message.get("message")
        if isinstance(nested, dict):
            text = first_text(nested.get("content"), max_chars=max_chars)
            if isinstance(text, str) and text.strip():
                return trim_text(text, max_chars)
    return None


def append_hook_progress(lines, data, timestamp, source_offset=None):
    hook_event = data.get("hookEvent") if isinstance(data.get("hookEvent"), str) else None
    hook_name = data.get("hookName") if isinstance(data.get("hookName"), str) else None
    if hook_event is None and hook_name is None:
        return 0
    summary = None
    message = data.get("message")
    if isinstance(message, dict):
        summary = first_text(message.get("content")) or first_text(message.get("text")) or first_text(message)
    if summary is None:
        command = data.get("command")
        summary = command if isinstance(command, str) else hook_name or hook_event or ""
    return append_line(lines, "hook_progress", summary, timestamp, role="assistant", hook_event=hook_event, hook_name=hook_name, source_offset=source_offset)


def count_hook_progress(data):
    hook_event = data.get("hookEvent") if isinstance(data.get("hookEvent"), str) else None
    hook_name = data.get("hookName") if isinstance(data.get("hookName"), str) else None
    return 1 if hook_event is not None or hook_name is not None else 0


def materialize_value_json(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value


def rows_from_source_document(raw):
    """Accept either owner fact rows or the package's source DATA manifest."""
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict) or not isinstance(raw.get("things"), list):
        return []

    rows = []
    for thing in raw["things"]:
        if not isinstance(thing, dict):
            continue
        candidates = [thing.get("payload")]
        payload_text = thing.get("payload_text")
        if isinstance(payload_text, str) and payload_text:
            candidates.append(payload_text)
        payload_base64 = thing.get("payload_base64")
        if isinstance(payload_base64, str) and payload_base64:
            try:
                candidates.append(base64.b64decode(payload_base64).decode("utf-8"))
            except Exception:
                pass
        for candidate in candidates:
            candidate = materialize_value_json(candidate)
            if isinstance(candidate, dict):
                rows.append(candidate)
                break
    return rows


def normalize_source_descriptors(raw):
    descriptors = []
    rows = rows_from_source_document(raw)
    for row in rows:
        values = None
        if isinstance(row, dict) and row.get("property_id") == TRANSCRIPT_SOURCE_PROPERTY:
            values = materialize_value_json(row.get("value_json"))
        elif isinstance(row, dict) and ("account_prefix" in row or "accountPrefix" in row):
            values = [row]
        if isinstance(values, dict):
            values = [values]
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, dict):
                continue
            account_prefix = value.get("account_prefix") or value.get("accountPrefix")
            root_path = value.get("root_path") or value.get("rootPath")
            glob_pattern = value.get("glob") or value.get("glob_pattern") or value.get("globPattern")
            cli_id = value.get("cli_id") or value.get("cliId")
            if not isinstance(account_prefix, str) or not account_prefix:
                continue
            if not isinstance(root_path, list) or not all(isinstance(part, str) for part in root_path):
                continue
            if not isinstance(glob_pattern, str) or not glob_pattern:
                continue
            descriptors.append({
                "source_id": value.get("source_id") or value.get("sourceId") or f"{account_prefix}:{'/'.join(root_path)}:{glob_pattern}",
                "cli_id": cli_id if isinstance(cli_id, str) and cli_id else account_prefix.lstrip("."),
                "account_prefix": account_prefix,
                "root_path": root_path,
                "glob": glob_pattern,
                "project_slug": value.get("project_slug") or value.get("projectSlug"),
                "non_human_envelope_roots": [
                    root for root in (
                        value.get("non_human_envelope_roots")
                        or value.get("nonHumanEnvelopeRoots")
                        or []
                    )
                    if isinstance(root, str) and root
                ],
                "non_human_message_prefixes": [
                    {
                        "id": prefix.get("id"),
                        "value": prefix.get("value"),
                    }
                    for prefix in (
                        value.get("non_human_message_prefixes")
                        or value.get("nonHumanMessagePrefixes")
                        or []
                    )
                    if isinstance(prefix, dict)
                    and isinstance(prefix.get("id"), str)
                    and prefix.get("id")
                    and isinstance(prefix.get("value"), str)
                    and prefix.get("value")
                ],
            })
    return descriptors


def read_source_descriptors(path_text):
    if not path_text:
        raise SystemExit("missing transcript source descriptor file")
    path = pathlib.Path(path_text)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"invalid transcript source descriptor file: {path}") from exc
    descriptors = normalize_source_descriptors(raw)
    if not descriptors:
        raise SystemExit(f"no transcript sources published in descriptor file: {path}")
    return descriptors


def source_scan_root(account_root, source):
    root = account_root
    for part in source.get("root_path", []):
        root = root / part
    return root


def iter_transcript_files(home, sources):
    for account_root in sorted(home.iterdir()):
        if not account_root.is_dir():
            continue
        account_dir = account_root.name
        for source in sources:
            account_prefix = source.get("account_prefix")
            if not isinstance(account_prefix, str) or not account_dir.startswith(account_prefix):
                continue
            scan_root = source_scan_root(account_root, source)
            if not scan_root.exists() or not scan_root.is_dir():
                continue
            for transcript_path in scan_root.glob(source["glob"]):
                if transcript_path.is_file():
                    yield source, account_dir, scan_root, transcript_path


def classify_transcript_path(path_obj, home, sources):
    for account_root in sorted(home.iterdir()):
        if not account_root.is_dir():
            continue
        account_dir = account_root.name
        for source in sources:
            account_prefix = source.get("account_prefix")
            if not isinstance(account_prefix, str) or not account_dir.startswith(account_prefix):
                continue
            scan_root = source_scan_root(account_root, source)
            try:
                path_obj.relative_to(scan_root)
                return source, account_dir, scan_root
            except ValueError:
                continue
    raise ValueError(f"unsupported transcript source path: {path_obj}")


def iter_hot_transcript_files(home, sources):
    candidates = []
    for source, account_dir, scan_root, transcript_path in iter_transcript_files(home, sources):
        try:
            stat_info = transcript_path.stat()
        except OSError:
            continue
        key = (stat_info.st_mtime, str(transcript_path))
        candidates.append((key, source, account_dir, scan_root, transcript_path))
    for _key, source, account_dir, scan_root, transcript_path in sorted(candidates, reverse=True):
        yield source, account_dir, scan_root, transcript_path


def compute_project_slug(source, relative_path, cwd, raw_session_id):
    rule = source.get("project_slug")
    if isinstance(rule, dict) and rule.get("from") == "relative_path_segment":
        parts = pathlib.Path(relative_path).parts
        index = rule.get("index")
        index = index if isinstance(index, int) else 0
        if 0 <= index < len(parts):
            return parts[index]
    if isinstance(rule, dict) and rule.get("from") == "cwd_basename":
        if isinstance(cwd, str) and cwd:
            return pathlib.Path(cwd).name or raw_session_id
    if isinstance(rule, dict) and rule.get("from") == "file_stem":
        return pathlib.Path(relative_path).stem or raw_session_id
    if isinstance(cwd, str) and cwd:
        return pathlib.Path(cwd).name or raw_session_id
    return pathlib.Path(relative_path).stem or raw_session_id


class TranscriptState:
    def __init__(self, source_session_id):
        self.message_count = 0
        self.started_at = None
        self.last_activity_at = None
        self.cwd = None
        self.model = None
        self.slug = None
        self.agent_id = None
        self.prompt = None
        self.source_session_id = source_session_id
        self.pending_user_contents = []
        self.pending_user_count = 0
        self.pending_user_prompt_candidates = []
        self.ignore_response_user_mirrors = False

    def queue_user_content(self, content, timestamp, usage, include_transcript, source_offset):
        prompt_text = first_text(content, max_chars=None if include_transcript else MAX_METADATA_TEXT_CHARS)
        if isinstance(prompt_text, str) and prompt_text.strip():
            self.pending_user_prompt_candidates.append(trim_text(prompt_text, None if include_transcript else MAX_METADATA_TEXT_CHARS))
        if include_transcript:
            self.pending_user_contents.append((content, timestamp, usage, source_offset))
        else:
            self.pending_user_count += count_content_units(content)

    def flush_pending_user_contents(self, lines, include_transcript):
        if self.prompt is None and self.pending_user_prompt_candidates:
            self.prompt = self.pending_user_prompt_candidates[0]
        if include_transcript:
            for content, timestamp, usage, source_offset in self.pending_user_contents:
                self.message_count += normalize_content(lines, "user", content, timestamp, usage=usage, source_offset=source_offset)
        else:
            self.message_count += self.pending_user_count
        self.pending_user_contents = []
        self.pending_user_count = 0
        self.pending_user_prompt_candidates = []

    def discard_pending_user_contents(self):
        self.pending_user_contents = []
        self.pending_user_count = 0
        self.pending_user_prompt_candidates = []

    def append_explicit_user_message(self, lines, message, timestamp, include_transcript, source_offset):
        self.discard_pending_user_contents()
        if self.prompt is None and isinstance(message, str) and message.strip():
            self.prompt = trim_text(message, None if include_transcript else MAX_METADATA_TEXT_CHARS)
        if include_transcript:
            self.message_count += normalize_content(lines, "user", message, timestamp, source_offset=source_offset)
        else:
            self.message_count += count_content_units(message)

    def accept_event(self, event, lines, include_transcript, prompt_limit=None, source_offset=None):
        if not isinstance(event, dict):
            return
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        event_type = event.get("type")
        if event_type in SKIP_TYPES:
            return
        timestamp = normalize_ts(event.get("timestamp") or payload.get("timestamp") or event.get("created_at") or event.get("updated_at"))
        if timestamp:
            if self.started_at is None or timestamp < self.started_at:
                self.started_at = timestamp
            if self.last_activity_at is None or timestamp > self.last_activity_at:
                self.last_activity_at = timestamp
        for candidate_cwd in (
            event.get("cwd"),
            payload.get("cwd"),
            event.get("message", {}).get("cwd") if isinstance(event.get("message"), dict) else None,
        ):
            if self.cwd is None and isinstance(candidate_cwd, str) and candidate_cwd:
                self.cwd = candidate_cwd
        if self.slug is None and isinstance(event.get("slug"), str) and event.get("slug"):
            self.slug = event.get("slug")
        for candidate_agent_id in (event.get("agentId"), payload.get("agentId"), data.get("agentId")):
            if self.agent_id is None and isinstance(candidate_agent_id, str) and candidate_agent_id:
                self.agent_id = candidate_agent_id
        if isinstance(event.get("sessionId"), str) and event.get("sessionId"):
            self.source_session_id = event["sessionId"]
        if event_type == "session_meta" and isinstance(payload.get("id"), str) and payload.get("id"):
            self.source_session_id = payload["id"]
        if event_type == "last-prompt":
            last_prompt = event.get("lastPrompt")
            if self.prompt is None and isinstance(last_prompt, str) and last_prompt.strip():
                self.prompt = trim_text(last_prompt, prompt_limit)
            return
        message = event.get("message") if isinstance(event.get("message"), dict) else None
        for candidate_model in (message.get("model") if isinstance(message, dict) else None, event.get("model"), payload.get("model")):
            if isinstance(candidate_model, str) and candidate_model:
                self.model = candidate_model
                break
        native_item = native_user_message_item(event)
        if native_item is not None:
            # item_completed/UserMessage is the current Codex source of human
            # occurrences. Its response_item copy is suppressed by the
            # file-level native-mode check in normalize_file.
            content = native_item.get("content")
            self.discard_pending_user_contents()
            if self.prompt is None:
                self.prompt = first_text(content, max_chars=None if include_transcript else prompt_limit)
            if include_transcript:
                self.message_count += normalize_content(
                    lines, "user", content, timestamp, source_offset=source_offset
                )
            else:
                self.message_count += count_content_units(content)
            return
        payload_type = payload.get("type")
        if event_type == "event_msg" and payload_type == "user_message" and isinstance(payload.get("message"), str):
            self.append_explicit_user_message(lines, payload.get("message"), timestamp, include_transcript, source_offset)
            return
        top_level_role = event.get("role")
        if top_level_role in CHAT_ROLES and "content" in event:
            content = event.get("content")
            if top_level_role == "user":
                self.flush_pending_user_contents(lines, include_transcript)
                self.queue_user_content(content, timestamp, None, include_transcript, source_offset)
            else:
                self.flush_pending_user_contents(lines, include_transcript)
                if include_transcript:
                    self.message_count += normalize_content(lines, "assistant", content, timestamp, source_offset=source_offset)
                else:
                    self.message_count += count_content_units(content)
            return
        if event_type in CHAT_ROLES and not isinstance(message, dict) and "message" in event:
            content = event.get("message")
            if event_type == "user":
                self.flush_pending_user_contents(lines, include_transcript)
                self.queue_user_content(content, timestamp, None, include_transcript, source_offset)
            else:
                self.flush_pending_user_contents(lines, include_transcript)
                if include_transcript:
                    self.message_count += normalize_content(lines, "assistant", content, timestamp, source_offset=source_offset)
                else:
                    self.message_count += count_content_units(content)
            return
        if isinstance(message, dict):
            role = message.get("role")
            content = message.get("content")
            usage = normalize_usage(message.get("usage"))
            if role == "user" or event_type == "user":
                self.flush_pending_user_contents(lines, include_transcript)
                self.queue_user_content(content, timestamp, usage, include_transcript, source_offset)
            elif role == "assistant" or event_type == "assistant":
                self.flush_pending_user_contents(lines, include_transcript)
                if include_transcript:
                    self.message_count += normalize_content(lines, "assistant", content, timestamp, usage=usage, source_offset=source_offset)
                else:
                    self.message_count += count_content_units(content)
            return
        if event_type == "progress":
            if self.prompt is None:
                self.prompt = extract_progress_prompt(data, max_chars=prompt_limit)
            if data.get("type") == "hook_progress":
                self.flush_pending_user_contents(lines, include_transcript)
                if include_transcript:
                    self.message_count += append_hook_progress(lines, data, timestamp, source_offset=source_offset)
                else:
                    self.message_count += count_hook_progress(data)
            return
        if payload_type == "message":
            role = payload.get("role")
            usage = normalize_usage(payload.get("usage"))
            if role in CHAT_ROLES:
                if role == "user" and getattr(self, "ignore_response_user_mirrors", False):
                    return
                if role == "user":
                    self.queue_user_content(payload.get("content"), timestamp, usage, include_transcript, source_offset)
                else:
                    self.flush_pending_user_contents(lines, include_transcript)
                    if include_transcript:
                        self.message_count += normalize_content(lines, role, payload.get("content"), timestamp, usage=usage, source_offset=source_offset)
                    else:
                        self.message_count += count_content_units(payload.get("content"))
            return
        if payload_type in TOOL_CALL_TYPES:
            self.flush_pending_user_contents(lines, include_transcript)
            if include_transcript:
                tool_name = payload.get("name") if isinstance(payload.get("name"), str) else "Tool"
                tool_input = parse_tool_call_input(payload)
                content_text = json.dumps(tool_input, ensure_ascii=False, sort_keys=True) if tool_input else tool_name
                self.message_count += append_line(lines, "tool_use", content_text, timestamp, role="assistant", tool_name=tool_name, tool_input=tool_input, tool_use_id=payload.get("call_id"), source_offset=source_offset)
            else:
                self.message_count += 1
            return
        if payload_type in TOOL_RESULT_TYPES:
            self.flush_pending_user_contents(lines, include_transcript)
            if include_transcript:
                content_text = first_text(payload.get("output"))
                if content_text is None and payload.get("output") is not None:
                    content_text = json.dumps(payload.get("output"), ensure_ascii=False)
                self.message_count += append_line(lines, "tool_result", content_text or "", timestamp, role="assistant", tool_use_id=payload.get("call_id"), source_offset=source_offset)
            elif payload.get("output") is not None:
                self.message_count += 1
            return
        if payload_type == "reasoning":
            self.flush_pending_user_contents(lines, include_transcript)
            if include_transcript:
                self.message_count += append_line(lines, "thinking", first_text(payload.get("summary")) or first_text(payload.get("content")) or "", timestamp, role="assistant", source_offset=source_offset)
            elif has_text(payload.get("summary")) or has_text(payload.get("content")):
                self.message_count += 1

    def fill_prompt_from_lines(self, lines):
        if self.prompt is not None or lines is None:
            return
        for line in lines:
            if line.get("role") == "human" and isinstance(line.get("content"), str) and line["content"].strip():
                self.prompt = line["content"].strip()
                break

    def merge_missing(self, other):
        if other.started_at is not None and (self.started_at is None or other.started_at < self.started_at):
            self.started_at = other.started_at
        if other.last_activity_at is not None and (
            self.last_activity_at is None or other.last_activity_at > self.last_activity_at
        ):
            self.last_activity_at = other.last_activity_at
        for key in ("cwd", "model", "slug", "agent_id", "prompt"):
            if getattr(self, key) is None:
                setattr(self, key, getattr(other, key))
        if self.source_session_id == "" or self.source_session_id is None:
            self.source_session_id = other.source_session_id

    def to_record(self, path_obj, source, account_dir, scan_root, include_transcript, lines=None):
        self.fill_prompt_from_lines(lines)
        stat_info = path_obj.stat()
        modified_at = iso_from_epoch(stat_info.st_mtime)
        started_at = self.started_at or modified_at
        last_activity_at = self.last_activity_at or modified_at
        relative_path = str(path_obj.relative_to(scan_root))
        digest = hashlib.sha256(f"{source.get('source_id')}:{account_dir}:{relative_path}".encode("utf-8")).hexdigest()
        project_name = pathlib.Path(self.cwd).name if isinstance(self.cwd, str) and self.cwd else None
        project_slug = compute_project_slug(source, relative_path, self.cwd, self.source_session_id)
        cli_id = source.get("cli_id") or account_dir.lstrip(".") or "unknown"
        record = {
            "record_id": f"chat_session:{digest}",
            "transcript_id": f"session_transcript:{digest}",
            "session_id": self.source_session_id,
            "agent_id": self.agent_id,
            "cli_id": cli_id,
            "model": self.model,
            "slug": self.slug,
            "prompt": self.prompt,
            "project_name": project_name,
            "project_slug": project_slug,
            "project_path": self.cwd,
            "started_at": started_at,
            "last_activity_at": last_activity_at,
            "message_count": self.message_count,
            "account_dir": account_dir,
            "file_path": str(path_obj),
            "file_size_bytes": stat_info.st_size,
            "file_modified_at": modified_at,
        }
        if include_transcript and lines is not None:
            record["transcript_content"] = json.dumps(strip_internal_line_fields(lines), ensure_ascii=False)
        return record


def parse_event_line(raw_line):
    if isinstance(raw_line, bytes):
        raw_line = raw_line.decode("utf-8", errors="replace")
    if not raw_line.strip():
        return None
    try:
        event = json.loads(raw_line)
    except Exception:
        return None
    return event if isinstance(event, dict) else None


def iter_event_records_with_offsets(path_obj, strict=False):
    """Yield stable source positions and dict events from JSONL or one JSON array.

    File shape is detected from bytes, never from provider identity. JSONL stays
    streaming. Array inputs are size-guarded before materialization so a malformed
    or hostile transcript cannot grow memory without a fixed ceiling.
    """
    with path_obj.open("rb") as handle:
        prefix = handle.read(4096)
        first = next((byte for byte in prefix if not chr(byte).isspace()), None)
        handle.seek(0)
        if first == ord("["):
            if path_obj.stat().st_size > MAX_JSON_ARRAY_TRANSCRIPT_BYTES:
                raise ValueError("json array transcript exceeds bounded byte ceiling")
            value = json.loads(handle.read().decode("utf-8"))
            if not isinstance(value, list):
                if strict:
                    raise ValueError("JSON transcript root must be an array or JSONL object stream")
                return
            for source_offset, event in enumerate(value):
                if isinstance(event, dict):
                    yield source_offset, event
                elif strict:
                    raise ValueError(f"malformed transcript record at array index {source_offset}: expected object")
            return
        while True:
            source_offset = handle.tell()
            raw_line = handle.readline(MAX_JSONL_EVENT_BYTES + 1)
            if not raw_line:
                break
            if len(raw_line) > MAX_JSONL_EVENT_BYTES and not raw_line.endswith(b"\n"):
                raise ValueError(
                    f"JSONL transcript record at byte offset {source_offset} exceeds "
                    f"{MAX_JSONL_EVENT_BYTES} bytes"
                )
            event = parse_event_line(raw_line)
            if event is not None:
                yield source_offset, event
            elif strict and raw_line.strip():
                raise ValueError(f"malformed transcript record at byte offset {source_offset}: expected JSON object")


def iter_event_records(path_obj):
    for _source_offset, event in iter_event_records_with_offsets(path_obj):
        yield event


def event_record_position_kind(path_obj):
    with path_obj.open("rb") as handle:
        prefix = handle.read(4096)
    first = next((byte for byte in prefix if not chr(byte).isspace()), None)
    return "array_index" if first == ord("[") else "byte_offset"


def declared_event_session_id(event):
    if not isinstance(event, dict):
        return None
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    candidates = [event.get("sessionId"), event.get("session_id")]
    if event.get("type") == "session_meta":
        candidates.append(payload.get("id"))
    if event.get("type") == "event_msg" and payload.get("type") == "item_completed":
        candidates.append(payload.get("thread_id"))
    for value in candidates:
        if isinstance(value, str) and value:
            return value
    return None


def native_user_message_item(event):
    """Return a current Codex completed UserMessage item, if present."""
    if not isinstance(event, dict):
        return None
    payload = event.get("payload")
    if event.get("type") != "event_msg" or not isinstance(payload, dict):
        return None
    if payload.get("type") != "item_completed":
        return None
    item = payload.get("item")
    if not isinstance(item, dict) or item.get("type") != "UserMessage":
        return None
    return item


def native_user_event_id(event):
    item = native_user_message_item(event)
    if item is None:
        return None
    item_id = item.get("id")
    return item_id if isinstance(item_id, str) and item_id else None


def transcript_contains_session_id(path_obj, session_id):
    try:
        return any(declared_event_session_id(event) == session_id for event in iter_event_records(path_obj))
    except Exception:
        return False


def strip_internal_line_fields(lines):
    public_lines = []
    for line in lines or []:
        if not isinstance(line, dict):
            continue
        public_line = dict(line)
        public_line.pop("_source_offset", None)
        public_lines.append(public_line)
    return public_lines


def normalize_file(
    path_obj,
    source,
    account_dir,
    scan_root,
    include_transcript,
    line_sink=None,
    session_id_filter=None,
    strict_events=False,
):
    lines = line_sink if line_sink is not None else ([] if include_transcript else None)
    prompt_limit = None if include_transcript else MAX_METADATA_TEXT_CHARS
    state = TranscriptState(path_obj.stem)

    try:
        # A full bounded prepass decides whether native occurrences are present
        # before emitting any rows, so a later native event can suppress earlier
        # response-item mirrors without buffering the transcript in memory.
        has_native_occurrences = any(
            native_user_message_item(event) is not None
            and (not session_id_filter or declared_event_session_id(event) == session_id_filter)
            for _offset, event in iter_event_records_with_offsets(path_obj, strict=strict_events)
        )
        state.ignore_response_user_mirrors = has_native_occurrences
        for source_offset, event in iter_event_records_with_offsets(path_obj, strict=strict_events):
            declared_session_id = declared_event_session_id(event)
            if session_id_filter and declared_session_id and declared_session_id != session_id_filter:
                continue
            if line_sink is not None and isinstance(line_sink, UserMessageSpool):
                line_sink.set_source_context(path_obj, native_user_event_id(event))
            state.accept_event(event, lines, include_transcript, prompt_limit=prompt_limit, source_offset=source_offset)
    except Exception:
        if strict_events:
            raise
        return None

    state.flush_pending_user_contents(lines, include_transcript)
    if line_sink is not None:
        return state.to_record(path_obj, source, account_dir, scan_root, include_transcript=False, lines=lines)
    return state.to_record(path_obj, source, account_dir, scan_root, include_transcript=include_transcript, lines=lines)


def read_prefix_metadata_state(path_obj):
    state = TranscriptState(path_obj.stem)
    try:
        for index, event in enumerate(iter_event_records(path_obj)):
            if index >= TAIL_CURSOR_PREFIX_METADATA_LINES:
                break
            state.accept_event(event, None, include_transcript=False, prompt_limit=MAX_METADATA_TEXT_CHARS)
    except Exception:
        return TranscriptState(path_obj.stem)
    return state


def read_raw_rows_before(path_obj, before_offset, max_bytes):
    stat_info = path_obj.stat()
    file_size = stat_info.st_size
    end = file_size if before_offset is None else max(0, min(int(before_offset), file_size))
    start = max(0, end - max(1, int(max_bytes)))
    if end <= 0:
        return [], True

    with path_obj.open("rb") as handle:
        handle.seek(start)
        data = handle.read(end - start)

    if start > 0:
        first_newline = data.find(b"\n")
        if first_newline < 0:
            return [], False
        start += first_newline + 1
        data = data[first_newline + 1:]
    if data.endswith(b"\n"):
        data = data[:-1]
    if not data:
        return [], start == 0

    rows = []
    offset = start
    for raw_line in data.split(b"\n"):
        line_start = offset
        offset += len(raw_line) + 1
        if raw_line.strip():
            rows.append((line_start, raw_line))
    return rows, start == 0


def normalize_raw_rows(path_obj, rows):
    state = TranscriptState(path_obj.stem)
    lines = []
    for source_offset, raw_line in rows:
        event = parse_event_line(raw_line)
        if event is not None:
            state.accept_event(event, lines, include_transcript=True, prompt_limit=None, source_offset=source_offset)
    state.flush_pending_user_contents(lines, include_transcript=True)
    return state, lines


def split_public_lines_and_older_cursor(lines):
    public_lines = []
    offsets = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        source_offset = line.get("_source_offset")
        if isinstance(source_offset, int) and source_offset >= 0:
            offsets.append(source_offset)
        public_line = dict(line)
        public_line.pop("_source_offset", None)
        public_lines.append(public_line)
    older_cursor = min(offsets) if offsets else None
    return public_lines, older_cursor


def run_cursor_transcript_page(out_path, path_obj, source, account_dir, scan_root, before_byte_offset, limit):
    stat_info = path_obj.stat()
    limit = max(1, min(int(limit), MAX_TRANSCRIPT_PAGE_MESSAGES))
    end_offset = stat_info.st_size if before_byte_offset is None else max(0, min(int(before_byte_offset), stat_info.st_size))
    read_bytes = min(max(TAIL_CURSOR_READ_BYTES, 1), max(end_offset, 1))
    rows = []
    reached_start = end_offset == 0
    tail_state = TranscriptState(path_obj.stem)
    lines = []

    while True:
        rows, reached_start = read_raw_rows_before(path_obj, end_offset, read_bytes)
        tail_state, lines = normalize_raw_rows(path_obj, rows)
        if len(lines) >= limit or reached_start:
            break
        next_read_bytes = min(read_bytes * 2, max(end_offset, 1))
        if next_read_bytes == read_bytes:
            break
        read_bytes = next_read_bytes

    selected_lines = lines[-limit:]
    public_lines, older_cursor = split_public_lines_and_older_cursor(selected_lines)
    prefix_state = read_prefix_metadata_state(path_obj)
    prefix_state.merge_missing(tail_state)
    record = prefix_state.to_record(path_obj, source, account_dir, scan_root, include_transcript=False, lines=public_lines)
    has_older = older_cursor is not None and older_cursor > 0

    write_json(out_path, {
        "version": 1,
        "start_index": None,
        "requested_start_index": None,
        "limit": limit,
        "total_count": None,
        "total_count_known": False,
        "lines": public_lines,
        "has_older": has_older,
        "has_newer": before_byte_offset is not None and end_offset < stat_info.st_size,
        "older_cursor": older_cursor if has_older else None,
        "file_path": str(path_obj),
        "project_path": record.get("project_path"),
        "file_size_bytes": record.get("file_size_bytes"),
        "file_modified_at": record.get("file_modified_at"),
        "started_at": record.get("started_at"),
        "last_activity_at": record.get("last_activity_at"),
    })


def index_file(path_obj, source, account_dir, scan_root):
    try:
        stat_info = path_obj.stat()
        relative_path = str(path_obj.relative_to(scan_root))
    except Exception:
        return None

    state = read_prefix_metadata_state(path_obj)
    modified_at = iso_from_epoch(stat_info.st_mtime)
    digest = hashlib.sha256(f"{source.get('source_id')}:{account_dir}:{relative_path}".encode("utf-8")).hexdigest()
    source_session_id = state.source_session_id or path_obj.stem
    cli_id = source.get("cli_id") or account_dir.lstrip(".") or "unknown"
    project_slug = compute_project_slug(source, relative_path, state.cwd, source_session_id)
    project_name = pathlib.Path(state.cwd).name if isinstance(state.cwd, str) and state.cwd else None

    return {
        "record_id": f"chat_session:{digest}",
        "transcript_id": f"session_transcript:{digest}",
        "session_id": source_session_id,
        "agent_id": state.agent_id,
        "cli_id": cli_id,
        "model": state.model,
        "slug": state.slug,
        "prompt": state.prompt,
        "project_name": project_name,
        "project_slug": project_slug,
        "started_at": modified_at,
        "last_activity_at": modified_at,
        "message_count": 0,
        "account_dir": account_dir,
        "file_path": str(path_obj),
        "file_size_bytes": stat_info.st_size,
        "file_modified_at": modified_at,
    }


def scan_index_records(sources):
    records = []
    home = pathlib.Path.home()
    for source, account_dir, scan_root, transcript_path in iter_hot_transcript_files(home, sources):
        record = index_file(transcript_path, source, account_dir, scan_root)
        if record is not None:
            key = (record.get("last_activity_at") or "", record.get("record_id") or "")
            records.append((key, record.get("record_id") or "", record))
    return [entry[2] for entry in sorted(records, key=lambda entry: entry[0], reverse=True)]


def add_feed_row(rows, subject_id, property_id, value):
    if value is None:
        return
    rows.append({
        "subject_id": subject_id,
        "property_id": property_id,
        "value_json": value,
    })


def cell_to_record_table_bytes(value, kind):
    if value is None:
        return None
    if kind in ("text", "non_empty_text"):
        text = str(value)
        if kind == "non_empty_text" and not text:
            return None
        return text.encode("utf-8")
    if kind == "number":
        return str(value).encode("utf-8")
    if kind == "json":
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if kind == "byte_boolean":
        return b"\x01" if bool(value) else b"\x00"
    raise ValueError(f"unsupported record table cell kind: {kind}")


def read_u32_le(bytes_value, offset):
    if offset < 0 or offset + 4 > len(bytes_value):
        raise ValueError("record table u32 read is out of bounds")
    return int.from_bytes(bytes_value[offset:offset + 4], "little")


def record_table_cell_from_bytes(cell, kind):
    if cell is None:
        return None
    if kind in ("text", "non_empty_text"):
        value = cell.decode("utf-8")
        return value if kind == "text" or value else None
    if kind == "number":
        text = cell.decode("utf-8").strip()
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            return float(text)
    if kind == "json":
        return json.loads(cell.decode("utf-8"))
    if kind == "byte_boolean":
        if len(cell) != 1:
            raise ValueError("record table byte_boolean cell must be exactly one byte")
        return cell[0] != 0
    raise ValueError(f"unsupported record table cell kind: {kind}")


def read_record_table(path_text, columns):
    path = pathlib.Path(path_text)
    if not path.exists():
        return []
    data = path.read_bytes()
    if len(data) < 16:
        raise ValueError("record table payload is shorter than the header")
    if data[0:4] != b"RTBL":
        raise ValueError("record table payload has invalid magic")
    if data[4:8] != b"\x00\x00\x00\x00":
        raise ValueError("record table reserved header bytes must be zero")

    row_count = read_u32_le(data, 8)
    column_count = read_u32_le(data, 12)
    if column_count > len(columns):
        raise ValueError(f"record table column count mismatch: expected at most {len(columns)}, got {column_count}")
    active_columns = columns[:column_count]

    cell_count = row_count * column_count
    index_start = 16
    index_len = cell_count * 8
    payload_start = index_start + index_len
    if payload_start > len(data):
        raise ValueError("record table index overruns payload")

    rows = []
    for row_index in range(row_count):
        row = {}
        for column_index, (key, kind) in enumerate(active_columns):
            index_offset = index_start + ((row_index * column_count + column_index) * 8)
            cell_offset = read_u32_le(data, index_offset)
            cell_len = read_u32_le(data, index_offset + 4)
            if cell_len == 0xFFFFFFFF:
                value = None
            else:
                cell_start = payload_start + cell_offset
                cell_end = cell_start + cell_len
                if cell_start < payload_start or cell_end > len(data):
                    raise ValueError("record table cell overruns payload bytes")
                value = record_table_cell_from_bytes(data[cell_start:cell_end], kind)
            if value is not None:
                row[key] = value
        rows.append(row)
    return rows


def encode_record_table(rows, columns):
    encoded_rows = []
    payload_len = 0
    for row in rows:
        encoded_row = []
        for key, kind in columns:
            cell = cell_to_record_table_bytes(row.get(key), kind)
            encoded_row.append(cell)
            if cell is not None:
                payload_len += len(cell)
        encoded_rows.append(encoded_row)

    row_count = len(encoded_rows)
    column_count = len(columns)
    cell_count = row_count * column_count
    index_len = cell_count * 8
    payload_start = 16 + index_len
    output = bytearray(payload_start + payload_len)
    output[0:4] = b"RTBL"
    # Bytes 4..8 are reserved by the shared RTBL contract and must stay zero.
    output[8:12] = row_count.to_bytes(4, "little")
    output[12:16] = column_count.to_bytes(4, "little")

    payload_offset = 0
    flat_index = 0
    for row in encoded_rows:
        for cell in row:
            index_offset = 16 + flat_index * 8
            flat_index += 1
            if cell is None:
                output[index_offset:index_offset + 4] = (0).to_bytes(4, "little")
                output[index_offset + 4:index_offset + 8] = (0xFFFFFFFF).to_bytes(4, "little")
                continue
            output[index_offset:index_offset + 4] = payload_offset.to_bytes(4, "little")
            output[index_offset + 4:index_offset + 8] = len(cell).to_bytes(4, "little")
            start = payload_start + payload_offset
            output[start:start + len(cell)] = cell
            payload_offset += len(cell)

    return bytes(output)


def write_bytes(out_path, content):
    path = pathlib.Path(out_path)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_bytes(content)
    tmp_path.replace(path)


def write_record_table(out_path, rows, columns):
    write_bytes(out_path, encode_record_table(rows, columns))


def read_title_overrides(path_text):
    if not path_text:
        return {}
    path = pathlib.Path(path_text)
    if not path.exists():
        return {}
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(rows, list):
        return {}

    titles = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        subject_id = row.get("subject_id")
        property_id = row.get("property_id")
        value = materialize_value_json(row.get("value_json"))
        if (
            isinstance(subject_id, str)
            and property_id == "prop:chat_session:title"
            and isinstance(value, str)
        ):
            titles[subject_id] = value
    return titles


def normalize_integer_fact(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return None
    return None


def normalize_boolean_fact(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes"}:
            return True
        if lowered in {"false", "0", "no"}:
            return False
    return None


def normalize_chat_session_fact_value(field, value):
    if value is None:
        return None
    if field in INTEGER_FACT_FIELDS:
        return normalize_integer_fact(value)
    if field in BOOLEAN_FACT_FIELDS:
        return normalize_boolean_fact(value)
    if isinstance(value, str):
        return value
    return str(value)


def read_fact_rows(path_text):
    value = read_json_value(path_text)
    if isinstance(value, dict) and isinstance(value.get("items"), list):
        return value.get("items")
    return value if isinstance(value, list) else []


def records_from_chat_session_fact_rows(rows):
    records_by_id = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        subject_id = row.get("subject_id")
        property_id = row.get("property_id")
        if not isinstance(subject_id, str) or not subject_id:
            continue
        if not isinstance(property_id, str):
            continue
        field = CHAT_SESSION_FACT_FIELD_BY_PROPERTY.get(property_id)
        if field is None:
            continue
        value = normalize_chat_session_fact_value(field, materialize_value_json(row.get("value_json")))
        if value is None:
            continue
        record = records_by_id.setdefault(subject_id, {"record_id": subject_id})
        record[field] = value

    def sort_key(record):
        last_activity = record.get("last_activity_at") or record.get("started_at") or ""
        record_id = record.get("record_id") or ""
        return (str(last_activity), str(record_id))

    return sorted(records_by_id.values(), key=sort_key, reverse=True)


def build_chat_session_feed_rows(records, title_overrides):
    rows = []
    for record in records:
        record_id = record.get("record_id")
        if not isinstance(record_id, str) or not record_id:
            continue
        rows.append({
            "recordId": record_id,
            "sessionId": record.get("session_id") or record_id,
            "agentId": record.get("agent_id"),
            "title": title_overrides.get(record_id) or record.get("title"),
            "cliId": record.get("cli_id") or "unknown",
            "model": record.get("model"),
            "slug": record.get("slug"),
            "prompt": record.get("prompt"),
            "projectName": record.get("project_name"),
            "projectSlug": record.get("project_slug") or "",
            "startedAt": record.get("started_at"),
            "lastActivityAt": record.get("last_activity_at") or record.get("started_at"),
            "messageCount": record.get("message_count") or 0,
            "accountDir": record.get("account_dir"),
            "filePath": record.get("file_path"),
            "fileSizeBytes": record.get("file_size_bytes"),
            "fileModifiedAt": record.get("file_modified_at"),
            "sourcePresent": record.get("source_present") if record.get("source_present") is not None else True,
            "projectPath": record.get("project_path"),
        })
    return rows


def bounded_session_window_limit(limit):
    return max(1, min(int(limit), 512))


def build_chat_session_window_rows(records, title_overrides):
    rows = []
    for record in records:
        record_id = record.get("record_id")
        if not isinstance(record_id, str) or not record_id:
            continue
        rows.append({
            "recordId": record_id,
            "sessionId": record.get("session_id") or record_id,
            "agentId": record.get("agent_id"),
            "title": title_overrides.get(record_id) or record.get("title"),
            "executorRef": record.get("cli_id") or "unknown",
            "model": record.get("model"),
            "slug": record.get("slug"),
            "prompt": record.get("prompt"),
            "projectName": record.get("project_name"),
            "projectSlug": record.get("project_slug") or "",
            "startedAt": record.get("started_at"),
            "lastActivityAt": record.get("last_activity_at") or record.get("started_at"),
            "messageCount": record.get("message_count") or 0,
            "accountDir": record.get("account_dir"),
            "filePath": record.get("file_path"),
            "fileSizeBytes": record.get("file_size_bytes"),
            "fileModifiedAt": record.get("file_modified_at"),
            "sourcePresent": record.get("source_present") if record.get("source_present") is not None else True,
            "projectPath": record.get("project_path"),
        })
    return rows


def build_chat_session_window_from_feed_rows(feed_rows, title_overrides, limit):
    rows = []
    for feed_row in feed_rows:
        record_id = feed_row.get("recordId")
        if not isinstance(record_id, str) or not record_id:
            continue
        row = {
            "recordId": record_id,
            "sessionId": feed_row.get("sessionId") or record_id,
            "agentId": feed_row.get("agentId"),
            "title": title_overrides.get(record_id) or feed_row.get("title"),
            "executorRef": feed_row.get("cliId") or feed_row.get("executorRef") or "unknown",
            "model": feed_row.get("model"),
            "slug": feed_row.get("slug"),
            "prompt": feed_row.get("prompt"),
            "projectName": feed_row.get("projectName"),
            "projectSlug": feed_row.get("projectSlug") or "",
            "startedAt": feed_row.get("startedAt"),
            "lastActivityAt": feed_row.get("lastActivityAt") or feed_row.get("startedAt"),
            "messageCount": feed_row.get("messageCount") or 0,
            "accountDir": feed_row.get("accountDir"),
            "filePath": feed_row.get("filePath"),
            "fileSizeBytes": feed_row.get("fileSizeBytes"),
            "fileModifiedAt": feed_row.get("fileModifiedAt"),
            "sourcePresent": feed_row.get("sourcePresent") if feed_row.get("sourcePresent") is not None else True,
            "projectPath": feed_row.get("projectPath"),
        }
        rows.append(row)

    rows.sort(key=lambda row: (str(row.get("lastActivityAt") or ""), str(row.get("recordId") or "")), reverse=True)
    bounded_limit = bounded_session_window_limit(limit)
    return {
        "version": 1,
        "window_key": "latest",
        "limit": bounded_limit,
        "total_count": len(rows),
        "total_count_known": True,
        "rows": rows[:bounded_limit],
        "has_older": len(rows) > bounded_limit,
    }


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def sha_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def live_session_window_rows(sources, title_overrides, limit, active_threshold_seconds, now_epoch=None):
    """Generic live agent rows: an agent is working now when its transcript
    file was appended within the active threshold. Executor identity comes
    from the source descriptor data (cli_id) — no executor-brand branches."""
    now = float(now_epoch) if now_epoch is not None else time.time()
    threshold = max(1.0, float(active_threshold_seconds))
    home = pathlib.Path.home()
    bounded_limit = bounded_session_window_limit(limit)
    rows = []
    for source, account_dir, scan_root, transcript_path in iter_hot_transcript_files(home, sources):
        if len(rows) >= bounded_limit:
            break
        try:
            stat_info = transcript_path.stat()
        except OSError:
            continue
        record = index_file(transcript_path, source, account_dir, scan_root)
        if record is None:
            continue
        mapped = build_chat_session_window_rows([record], title_overrides)
        if not mapped:
            continue
        row = mapped[0]
        row["status"] = "working" if (now - stat_info.st_mtime) <= threshold else "idle"
        rows.append(row)
    return rows


def build_window_from_rows(rows, limit):
    unique = {}
    for row in rows:
        key = row.get("recordId") or row.get("sessionId")
        if isinstance(key, str) and key and key not in unique:
            unique[key] = row
    sorted_rows = sorted(
        unique.values(),
        key=lambda row: (str(row.get("lastActivityAt") or ""), str(row.get("recordId") or "")),
        reverse=True,
    )
    bounded_limit = bounded_session_window_limit(limit)
    return {
        "version": 1,
        "window_key": "latest",
        "limit": bounded_limit,
        "total_count": len(sorted_rows),
        "total_count_known": True,
        "rows": sorted_rows[:bounded_limit],
        "has_older": len(sorted_rows) > bounded_limit,
    }


def build_chat_session_window(records, title_overrides, limit):
    rows = build_chat_session_window_rows(records, title_overrides)
    bounded_limit = bounded_session_window_limit(limit)
    return {
        "version": 1,
        "window_key": "latest",
        "limit": bounded_limit,
        "total_count": len(rows),
        "total_count_known": True,
        "rows": rows[:bounded_limit],
        "has_older": len(rows) > bounded_limit,
    }


def build_session_transcript_feed_rows(records):
    rows = []
    for record in records:
        transcript_id = record.get("transcript_id")
        record_id = record.get("record_id")
        if not isinstance(transcript_id, str) or not transcript_id:
            continue
        add_feed_row(rows, transcript_id, "prop:session_transcript:session_id", record_id)
        add_feed_row(rows, transcript_id, "prop:session_transcript:message_count", record.get("message_count"))
        add_feed_row(rows, transcript_id, "prop:session_transcript:created_at", record.get("started_at"))
    return rows


def canonical_json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_fingerprint(value):
    return "sha256:" + hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def normalize_producer_material(value):
    if isinstance(value, str) and value:
        return {"available": True, "content_hash": value}
    if isinstance(value, dict):
        content_hash = value.get("content_hash")
        if isinstance(content_hash, str) and content_hash:
            return {"available": True, "content_hash": content_hash}
    return {"available": False}


def build_source_fingerprint(sources, title_overrides, producer_material=None):
    transcript_files = []
    latest_modified_ns = 0
    home = pathlib.Path.home()

    for source, account_dir, scan_root, transcript_path in iter_transcript_files(home, sources):
        try:
            stat_info = transcript_path.stat()
        except OSError:
            continue

        modified_ns = int(stat_info.st_mtime_ns)
        latest_modified_ns = max(latest_modified_ns, modified_ns)
        try:
            relative_path = str(transcript_path.relative_to(scan_root))
        except ValueError:
            relative_path = transcript_path.name

        transcript_files.append({
            "account_dir": account_dir,
            "cli_id": source.get("cli_id"),
            "file_modified_ns": modified_ns,
            "file_path": str(transcript_path),
            "file_size_bytes": int(stat_info.st_size),
            "relative_path": relative_path,
        })

    transcript_files.sort(key=lambda item: (item["file_path"], item["file_modified_ns"], item["file_size_bytes"]))
    source_descriptors = sorted(sources, key=lambda item: canonical_json_bytes(item))
    title_overrides = dict(sorted(title_overrides.items()))
    producer_material = normalize_producer_material(producer_material)
    closure = {
        "producer_material": producer_material,
        "source_descriptors": source_descriptors,
        "title_overrides": title_overrides,
        "transcript_files": transcript_files,
    }

    return {
        "version": 1,
        "algorithm": "sha256",
        "fingerprint": sha256_fingerprint(closure),
        "source_count": len(source_descriptors),
        "file_count": len(transcript_files),
        "latest_file_modified_ns": latest_modified_ns,
        "latest_file_modified_at": iso_from_epoch(latest_modified_ns / 1_000_000_000) if latest_modified_ns else None,
        "producer_material": producer_material,
    }


def run_source_fingerprint(out_path, title_overrides_path, sources_path, producer_material_path=None):
    sources = read_source_descriptors(sources_path)
    title_overrides = read_title_overrides(title_overrides_path)
    producer_material = read_json_value(producer_material_path) if producer_material_path else None
    write_json(out_path, build_source_fingerprint(sources, title_overrides, producer_material))


def read_json_object(path_text):
    if not path_text:
        return {}
    path = pathlib.Path(path_text)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def read_json_value(path_text):
    if not path_text:
        return None
    path = pathlib.Path(path_text)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def feed_status_requires_scan(status):
    if not isinstance(status, dict):
        return True
    if status.get("present") is False or status.get("kind") == "missing":
        return True
    size = status.get("size")
    content_hash = status.get("content_hash")
    return not (isinstance(size, int) and size > 0 and isinstance(content_hash, str) and content_hash)


def run_scan_needed(out_path, title_overrides_path, sources_path, previous_fingerprint_path, chat_status_path, transcripts_status_path, producer_material_path=None):
    sources = read_source_descriptors(sources_path)
    title_overrides = read_title_overrides(title_overrides_path)
    producer_material = read_json_value(producer_material_path) if producer_material_path else None
    current_fingerprint = build_source_fingerprint(sources, title_overrides, producer_material)
    previous_fingerprint = read_json_object(previous_fingerprint_path)
    chat_status = read_json_object(chat_status_path)
    transcripts_status = read_json_object(transcripts_status_path)

    reasons = []
    if previous_fingerprint.get("fingerprint") != current_fingerprint.get("fingerprint"):
        reasons.append("source_fingerprint_changed")
    if feed_status_requires_scan(chat_status):
        reasons.append("chat_sessions_feed_missing")
    if feed_status_requires_scan(transcripts_status):
        reasons.append("session_transcripts_feed_missing")

    write_json(out_path, {
        "version": 1,
        "scan_needed": bool(reasons),
        "reasons": reasons,
        "current_fingerprint": current_fingerprint,
        "existing": {
            "source_fingerprint_content_hash": previous_fingerprint.get("content_hash"),
            "chat_sessions_content_hash": chat_status.get("content_hash"),
            "chat_sessions_size": chat_status.get("size"),
            "session_transcripts_content_hash": transcripts_status.get("content_hash"),
            "session_transcripts_size": transcripts_status.get("size"),
        },
    })


def run_scan(out_path, sources_path):
    write_json(out_path, scan_index_records(read_source_descriptors(sources_path)))


def run_scan_feeds(chat_out_path, transcripts_out_path, title_overrides_path, sources_path):
    records = scan_index_records(read_source_descriptors(sources_path))
    title_overrides = read_title_overrides(title_overrides_path)
    write_record_table(
        chat_out_path,
        build_chat_session_feed_rows(records, title_overrides),
        CHAT_SESSION_TABLE_COLUMNS,
    )
    write_record_table(
        transcripts_out_path,
        build_session_transcript_feed_rows(records),
        SESSION_TRANSCRIPT_TABLE_COLUMNS,
    )


def run_scan_feeds_and_fingerprint(chat_out_path, transcripts_out_path, fingerprint_out_path, title_overrides_path, sources_path, producer_material_path=None):
    sources = read_source_descriptors(sources_path)
    title_overrides = read_title_overrides(title_overrides_path)
    producer_material = read_json_value(producer_material_path) if producer_material_path else None
    records = scan_index_records(sources)
    write_record_table(
        chat_out_path,
        build_chat_session_feed_rows(records, title_overrides),
        CHAT_SESSION_TABLE_COLUMNS,
    )
    write_record_table(
        transcripts_out_path,
        build_session_transcript_feed_rows(records),
        SESSION_TRANSCRIPT_TABLE_COLUMNS,
    )
    write_json(fingerprint_out_path, build_source_fingerprint(sources, title_overrides, producer_material))


def run_session_window(out_path, title_overrides_path, sources_path, limit):
    sources = read_source_descriptors(sources_path)
    title_overrides = read_title_overrides(title_overrides_path)
    records = scan_index_records(sources)
    write_json(out_path, build_chat_session_window(records, title_overrides, limit))


def run_session_window_from_facts(out_path, facts_path, title_overrides_path, limit):
    records = records_from_chat_session_fact_rows(read_fact_rows(facts_path))
    title_overrides = read_title_overrides(title_overrides_path)
    write_json(out_path, build_chat_session_window(records, title_overrides, limit))


def run_session_window_from_feed(out_path, feed_path, title_overrides_path, limit):
    feed_rows = read_record_table(feed_path, CHAT_SESSION_TABLE_COLUMNS)
    title_overrides = read_title_overrides(title_overrides_path)
    write_json(out_path, build_chat_session_window_from_feed_rows(feed_rows, title_overrides, limit))


def run_session_window_live(out_path, title_overrides_path, sources_path, limit, active_threshold_seconds):
    sources = read_source_descriptors(sources_path)
    title_overrides = read_title_overrides(title_overrides_path)
    rows = live_session_window_rows(sources, title_overrides, limit, active_threshold_seconds)
    write_json(out_path, build_window_from_rows(rows, limit))


def run_transcript(content_out_path, metadata_out_path, file_path, sources_path):
    path_obj = pathlib.Path(file_path).expanduser().resolve()
    source, account_dir, scan_root = classify_transcript_path(path_obj, pathlib.Path.home(), read_source_descriptors(sources_path))
    record = normalize_file(path_obj, source, account_dir, scan_root, include_transcript=True)
    write_text(content_out_path, "[]" if record is None else record.get("transcript_content", "[]"))
    write_json(metadata_out_path, {
        "message_count": 0 if record is None else record.get("message_count", 0),
        "agent_id": None if record is None else record.get("agent_id"),
        "model": None if record is None else record.get("model"),
        "slug": None if record is None else record.get("slug"),
        "prompt": None if record is None else record.get("prompt"),
        "project_name": None if record is None else record.get("project_name"),
        "project_slug": None if record is None else record.get("project_slug"),
        "project_path": None if record is None else record.get("project_path"),
        "started_at": None if record is None else record.get("started_at"),
        "last_activity_at": None if record is None else record.get("last_activity_at"),
    })


def parse_optional_int(value):
    if value is None:
        return None
    if isinstance(value, str) and value.strip() in {"", "null", "None"}:
        return None
    return int(value)


def run_transcript_page(out_path, file_path, start_index, limit, before_byte_offset, sources_path):
    path_obj = pathlib.Path(file_path).expanduser().resolve()
    parsed_start_index = int(start_index)
    parsed_before_offset = parse_optional_int(before_byte_offset)
    try:
        source, account_dir, scan_root = classify_transcript_path(path_obj, pathlib.Path.home(), read_source_descriptors(sources_path))
        stat_info = path_obj.stat()
    except Exception:
        source = account_dir = scan_root = stat_info = None

    if (
        source is not None
        and account_dir is not None
        and scan_root is not None
        and stat_info is not None
        and (parsed_before_offset is not None or parsed_start_index < 0)
    ):
        run_cursor_transcript_page(out_path, path_obj, source, account_dir, scan_root, parsed_before_offset, limit)
        return

    collector = TranscriptWindowCollector(int(start_index), int(limit))
    try:
        if source is None or account_dir is None or scan_root is None:
            source, account_dir, scan_root = classify_transcript_path(path_obj, pathlib.Path.home(), read_source_descriptors(sources_path))
        record = normalize_file(path_obj, source, account_dir, scan_root, include_transcript=True, line_sink=collector)
    except Exception:
        record = None

    total_count = collector.total_count if record is None else record.get("message_count", collector.total_count)
    resolved_start = collector.resolved_start_index()
    write_json(out_path, {
        "version": 1,
        "start_index": resolved_start,
        "requested_start_index": collector.requested_start_index,
        "limit": collector.limit,
        "total_count": total_count,
        "total_count_known": True,
        "lines": collector.lines,
        "has_older": resolved_start > 0,
        "has_newer": resolved_start + len(collector.lines) < total_count,
        "older_cursor": None,
        "file_path": str(path_obj),
        "project_path": None if record is None else record.get("project_path"),
        "file_size_bytes": None if record is None else record.get("file_size_bytes"),
        "file_modified_at": None if record is None else record.get("file_modified_at"),
        "started_at": None if record is None else record.get("started_at"),
        "last_activity_at": None if record is None else record.get("last_activity_at"),
    })


def run_selected_message_window(out_path, session_id, file_path, start_index, limit, before_byte_offset, sources_path):
    run_transcript_page(out_path, file_path, start_index, limit, before_byte_offset, sources_path)
    page = read_json_value(out_path)
    if not isinstance(page, dict):
        page = {}
    page["session_id"] = session_id
    page["window_key"] = "latest"
    write_json(out_path, page)


def whole_message_envelope_root(content):
    if not isinstance(content, str):
        return None
    match = re.fullmatch(
        r"\s*<([A-Za-z][A-Za-z0-9_.:-]*)(?:\s[^>]*)?>[\s\S]*</\1>\s*",
        content,
    )
    return match.group(1) if match else None


def message_occurrence_id(session_id, ordinal, timestamp, content_hash):
    material = json.dumps(
        {
            "session_id": session_id,
            "ordinal": ordinal,
            "timestamp": timestamp,
            "sha256": content_hash,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


class JsonArraySpool:
    """Append JSON rows without retaining the growing array in process memory."""

    def __init__(self, directory, prefix):
        descriptor, self.path = tempfile.mkstemp(prefix=prefix, dir=directory)
        self.handle = os.fdopen(descriptor, "w", encoding="utf-8")
        self.count = 0

    def append(self, value):
        if self.count:
            self.handle.write(",")
        self.handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        self.count += 1

    def close(self):
        if self.handle is not None:
            self.handle.flush()
            os.fsync(self.handle.fileno())
            self.handle.close()
            self.handle = None

    def write_array_to(self, destination):
        self.close()
        destination.write("[")
        with open(self.path, "r", encoding="utf-8") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                destination.write(chunk)
        destination.write("]")

    def cleanup(self):
        self.close()
        if os.path.exists(self.path):
            os.unlink(self.path)


class UserMessageSpool:
    """Normalize one transcript into two bounded-memory, ordered JSON spools."""

    def __init__(self, directory, session_id, excluded_roots, excluded_prefixes, source_position_kind):
        self.session_id = session_id
        self.excluded_roots = set(excluded_roots)
        self.excluded_prefixes = tuple(excluded_prefixes)
        self.source_position_kind = source_position_kind
        self.source_ordinal = 0
        self.current_source_path = None
        self.current_native_event_id = None
        self.source_files = []
        self.messages = JsonArraySpool(directory, ".user-messages.rows.")
        self.excluded = JsonArraySpool(directory, ".user-messages.excluded.")

    def set_source_context(self, path_obj, native_event_id):
        source_path = str(path_obj)
        if self.current_source_path != source_path:
            self.source_position_kind = event_record_position_kind(path_obj)
        self.current_source_path = source_path
        self.current_native_event_id = native_event_id
        if self.current_source_path not in self.source_files:
            self.source_files.append(self.current_source_path)

    def append(self, line):
        self.source_ordinal += 1
        if line.get("type") != "user" or line.get("role") != "human":
            return
        content = line.get("content")
        if not isinstance(content, str) or not content:
            return
        source_position = line.get("_source_offset")
        source_position_row = (
            {"kind": self.source_position_kind, "value": source_position}
            if isinstance(source_position, int) and source_position >= 0
            else None
        )
        envelope_root = whole_message_envelope_root(content)
        prefix_descriptor = next(
            (
                descriptor
                for descriptor in self.excluded_prefixes
                if content.lstrip().startswith(descriptor["value"])
            ),
            None,
        )
        if envelope_root in self.excluded_roots or prefix_descriptor is not None:
            exclusion_id = envelope_root if prefix_descriptor is None else prefix_descriptor["id"]
            row = {
                "source_ordinal": self.source_ordinal,
                "envelope_root": exclusion_id,
                "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            }
            if source_position_row is not None:
                row["source_position"] = source_position_row
            if self.current_source_path is not None:
                row["source_file"] = self.current_source_path
            if isinstance(self.current_native_event_id, str) and self.current_native_event_id:
                row["native_event_id"] = self.current_native_event_id
            self.excluded.append(row)
            return
        content_bytes = content.encode("utf-8")
        ordinal = self.messages.count + 1
        content_hash = hashlib.sha256(content_bytes).hexdigest()
        row = {
            "ordinal": ordinal,
            "source_ordinal": self.source_ordinal,
            "timestamp": line.get("timestamp"),
            "content": content,
            "content_bytes": len(content_bytes),
            "sha256": content_hash,
            "occurrence_id": message_occurrence_id(
                self.session_id,
                ordinal,
                line.get("timestamp"),
                content_hash,
            ),
        }
        if source_position_row is not None:
            row["source_position"] = source_position_row
        if self.current_source_path is not None:
            row["source_file"] = self.current_source_path
        if isinstance(self.current_native_event_id, str) and self.current_native_event_id:
            row["native_event_id"] = self.current_native_event_id
        if line.get("attachments"):
            row["attachments"] = line["attachments"]
        self.messages.append(row)

    def __iter__(self):
        return iter(())

    def close(self):
        self.messages.close()
        self.excluded.close()

    def cleanup(self):
        self.messages.cleanup()
        self.excluded.cleanup()


def write_user_messages_json(out_path, metadata, spool):
    path = pathlib.Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write("{")
            for index, (key, value) in enumerate(metadata.items()):
                if index:
                    handle.write(",")
                handle.write(json.dumps(key))
                handle.write(":")
                handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
            handle.write(",\"excluded_non_human_messages\":")
            spool.excluded.write_array_to(handle)
            handle.write(",\"messages\":")
            spool.messages.write_array_to(handle)
            handle.write("}")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def inspect_native_segment(candidate, session_id, native_ids, require_native):
    transcript_path = candidate[3]
    snapshot = transcript_path.stat()
    session_meta_ids = set()
    first_ordinal = None
    last_ordinal = None
    native_count = 0
    for _offset, event in iter_event_records_with_offsets(transcript_path, strict=True):
        if event.get("type") == "session_meta":
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if isinstance(payload.get("id"), str):
                session_meta_ids.add(payload["id"])
        item = native_user_message_item(event)
        if item is None:
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            raise ValueError(f"native UserMessage has missing or invalid item id at {transcript_path}")
        content = item.get("content")
        if not isinstance(content, (str, list)):
            raise ValueError(f"native UserMessage has invalid content at {transcript_path}")
        try:
            native_ids.execute("INSERT INTO native_ids (item_id) VALUES (?)", (item_id,))
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"duplicate native UserMessage item id: {item_id}") from exc
        payload = event.get("payload")
        ordinal = event.get("ordinal")
        if (not isinstance(payload, dict) or payload.get("thread_id") != session_id
                or not isinstance(ordinal, int) or isinstance(ordinal, bool)
                or (last_ordinal is not None and ordinal <= last_ordinal)):
            raise ValueError(f"native event identity or order does not match requested session in {transcript_path}")
        first_ordinal = ordinal if first_ordinal is None else first_ordinal
        last_ordinal = ordinal
        native_count += 1

    if require_native and (not native_count or session_meta_ids != {session_id}):
        raise ValueError(f"native session metadata mismatch in {transcript_path}")
    if native_count and session_meta_ids != {session_id}:
        raise ValueError(f"native session metadata mismatch in {transcript_path}")
    current = transcript_path.stat()
    if current.st_size != snapshot.st_size or current.st_mtime_ns != snapshot.st_mtime_ns:
        raise ValueError(f"transcript changed during qualification: {transcript_path}")
    return first_ordinal, last_ordinal, native_count, snapshot


def resolve_session_transcript(session_id, sources):
    matches = [
        candidate for candidate in iter_transcript_files(pathlib.Path.home(), sources)
        if candidate[3].stem == session_id
        or candidate[3].stem.endswith(session_id)
        or re.search(rf"(?:^|[-_]){re.escape(session_id)}(?:$|[-_])", candidate[3].stem)
    ]
    if not matches:
        for source, account_dir, scan_root, transcript_path in iter_transcript_files(pathlib.Path.home(), sources):
            if transcript_contains_session_id(transcript_path, session_id):
                matches.append((source, account_dir, scan_root, transcript_path))
    if not matches:
        raise SystemExit(f"no transcript found for exact session id: {session_id}")
    # A disk-backed uniqueness index detects duplicate native identities without
    # retaining all message IDs (or transcript bodies) in process memory.
    with tempfile.TemporaryDirectory(prefix="ai-cli-native-id-check-") as temp_dir:
        native_ids = sqlite3.connect(os.path.join(temp_dir, "native-ids.sqlite3"))
        try:
            native_ids.execute("CREATE TABLE native_ids (item_id TEXT PRIMARY KEY)")
            segments = []
            for candidate in matches:
                try:
                    first, last, count, snapshot = inspect_native_segment(
                        candidate, session_id, native_ids, require_native=len(matches) > 1
                    )
                except Exception as exc:
                    if len(matches) == 1:
                        raise SystemExit(f"failed to qualify transcript for exact session id {session_id}: {exc}") from exc
                    paths = ", ".join(sorted(str(item[3]) for item in matches))
                    raise SystemExit(f"ambiguous transcript session id {session_id}: {paths}") from exc
                segments.append((first, last, count, candidate, snapshot))
        finally:
            native_ids.close()

    if len(segments) == 1:
        _first, _last, _count, candidate, snapshot = segments[0]
        return [(candidate, snapshot)]
    segments.sort(key=lambda segment: (segment[0], str(segment[3][3])))
    if any(segments[index - 1][2] == 0 or segments[index][2] == 0
           or segments[index - 1][1] >= segments[index][0]
           for index in range(1, len(segments))):
        paths = ", ".join(sorted(str(item[3]) for item in matches))
        raise SystemExit(f"ambiguous transcript session id {session_id}: {paths}")
    return [(candidate, snapshot) for _first, _last, _count, candidate, snapshot in segments]


def run_user_messages(out_path, session_id, sources_path):
    sources = read_source_descriptors(sources_path)
    resolved = resolve_session_transcript(session_id, sources)
    candidates = resolved
    source, account_dir, scan_root, path_obj = candidates[0][0]
    excluded_roots = set(source.get("non_human_envelope_roots") or [])
    excluded_prefixes = tuple(source.get("non_human_message_prefixes") or [])
    source_position_kind = event_record_position_kind(path_obj)
    output_parent = pathlib.Path(out_path).parent
    output_parent.mkdir(parents=True, exist_ok=True)
    spool = UserMessageSpool(output_parent, session_id, excluded_roots, excluded_prefixes, source_position_kind)
    try:
        try:
            record = None
            for candidate, snapshot in candidates:
                candidate_source, candidate_account, candidate_root, candidate_path = candidate
                record = normalize_file(
                    candidate_path,
                    candidate_source,
                    candidate_account,
                    candidate_root,
                    include_transcript=True,
                    line_sink=spool,
                    session_id_filter=session_id,
                    strict_events=True,
                )
                current = candidate_path.stat()
                if current.st_size != snapshot.st_size or current.st_mtime_ns != snapshot.st_mtime_ns:
                    raise ValueError(f"transcript changed during extraction: {candidate_path}")
            path_obj = candidates[0][0][3]
        except Exception as exc:
            raise SystemExit(f"failed to normalize transcript for exact session id {session_id}: {exc}") from exc
        if record is None:
            raise SystemExit(f"failed to normalize transcript for exact session id: {session_id}")
        observed_session_id = record.get("session_id")
        # A forked Codex rollout is named <parent-id>_<child-id>; resolution accepted it by
        # stem suffix, so the normalized id may be that stem. Judge it by the same rule.
        if observed_session_id != session_id and not str(observed_session_id or "").endswith(session_id):
            raise SystemExit(
                f"normalized transcript session mismatch: requested {session_id}, observed {record.get('session_id')}"
            )
        for candidate, snapshot in candidates:
            candidate_path = candidate[3]
            current = candidate_path.stat()
            if current.st_size != snapshot.st_size or current.st_mtime_ns != snapshot.st_mtime_ns:
                raise SystemExit(f"transcript changed during extraction: {candidate_path}")
        spool.close()
        write_user_messages_json(out_path, {
            "schema": "ai-cli-conversations.user-messages/v1",
            "session_id": session_id,
            "provider": source.get("cli_id"),
            "source_id": source.get("source_id"),
            "file_path": str(path_obj),
            "source_files": spool.source_files,
            "source_segments": [
                {
                    "file_path": str(candidate[3]),
                    "file_size_bytes": snapshot.st_size,
                    "file_modified_at": iso_from_epoch(snapshot.st_mtime),
                }
                for candidate, snapshot in candidates
            ],
            "file_size_bytes": candidates[0][1].st_size,
            "file_modified_at": iso_from_epoch(candidates[0][1].st_mtime),
            "message_count": spool.messages.count,
            "excluded_non_human_message_count": spool.excluded.count,
        }, spool)
    finally:
        spool.cleanup()


def write_text(out_path, content):
    path = pathlib.Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(out_path, value):
    write_text(out_path, json.dumps(value, ensure_ascii=False))


def main(argv):
    if len(argv) < 3:
        raise SystemExit("usage: read-ai-cli-conversations.py scan <out.json> <sources.json> | scan-needed <decision.json> <title-overrides.json> <sources.json> <previous-fingerprint.json> <chat-status.json> <transcripts-status.json> [producer-material.json] | source-fingerprint <fingerprint.json> <title-overrides.json> <sources.json> [producer-material.json] | scan-feeds <chat-feed.rtbl> <transcripts-feed.rtbl> <title-overrides.json> <sources.json> | scan-feeds-and-fingerprint <chat-feed.rtbl> <transcripts-feed.rtbl> <fingerprint.json> <title-overrides.json> <sources.json> [producer-material.json] | session-window <window.json> <title-overrides.json> <sources.json> <limit> | session-window-from-feed <window.json> <chat-feed.rtbl> <title-overrides.json> <limit> | session-window-from-facts <window.json> <chat-session-facts.json> <title-overrides.json> <limit> | session-window-live <window.json> <title-overrides.json> <sources.json> <limit> <active-threshold-seconds> | transcript <content.json> <metadata.json> <file_path> <sources.json> | transcript-page <page.json> <file_path> <start_index|-1> <limit> [before_byte_offset|null] <sources.json> | selected-message-window <window.json> <session_id> <file_path> <start_index|-1> <limit> [before_byte_offset|null] <sources.json> | user-messages <messages.json> <session_id> <sources-or-manifest.json>")
    mode = argv[1]
    if mode == "scan" and len(argv) >= 4:
        run_scan(argv[2], argv[3])
        return
    if mode == "source-fingerprint" and len(argv) >= 5:
        producer_material_path = argv[5] if len(argv) >= 6 else None
        run_source_fingerprint(argv[2], argv[3], argv[4], producer_material_path)
        return
    if mode == "scan-needed" and len(argv) >= 8:
        producer_material_path = argv[8] if len(argv) >= 9 else None
        run_scan_needed(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], producer_material_path)
        return
    if mode == "scan-feeds" and len(argv) >= 6:
        run_scan_feeds(argv[2], argv[3], argv[4], argv[5])
        return
    if mode == "scan-feeds-and-fingerprint" and len(argv) >= 7:
        producer_material_path = argv[7] if len(argv) >= 8 else None
        run_scan_feeds_and_fingerprint(argv[2], argv[3], argv[4], argv[5], argv[6], producer_material_path)
        return
    if mode == "session-window" and len(argv) >= 6:
        run_session_window(argv[2], argv[3], argv[4], argv[5])
        return
    if mode == "session-window-from-feed" and len(argv) >= 6:
        run_session_window_from_feed(argv[2], argv[3], argv[4], argv[5])
        return
    if mode == "session-window-from-facts" and len(argv) >= 6:
        run_session_window_from_facts(argv[2], argv[3], argv[4], argv[5])
        return
    if mode == "session-window-live" and len(argv) >= 7:
        run_session_window_live(argv[2], argv[3], argv[4], argv[5], argv[6])
        return
    if mode == "transcript" and len(argv) >= 6:
        run_transcript(argv[2], argv[3], argv[4], argv[5])
        return
    if mode == "transcript-page" and len(argv) >= 7:
        if len(argv) >= 8:
            run_transcript_page(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7])
        else:
            run_transcript_page(argv[2], argv[3], argv[4], argv[5], None, argv[6])
        return
    if mode == "selected-message-window" and len(argv) >= 8:
        if len(argv) >= 9:
            run_selected_message_window(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8])
        else:
            run_selected_message_window(argv[2], argv[3], argv[4], argv[5], argv[6], None, argv[7])
        return
    if mode == "user-messages" and len(argv) >= 5:
        run_user_messages(argv[2], argv[3], argv[4])
        return
    raise SystemExit(f"unsupported mode: {mode}")


if __name__ == "__main__":
    main(sys.argv)
