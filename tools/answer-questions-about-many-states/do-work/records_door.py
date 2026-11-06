"""The run's records door, from Python's standard library: the same protocol as tools/records-door/read-data/records-door.mjs.

A row that declares `invoke.records: { fd, rights }` is handed, on that descriptor, one JSON line
{ url, resource, capability }. Every call is a JSON-RPC `tools/call` of `run_resource_operation` at that resource, sent to
the door's loopback address with the capability as its bearer. The capability is never printed, logged or returned.

    door = RecordsDoor.open()                 reads descriptor 3
    door.read(type, id)                       -> the value, or None
    door.list(type, prefix=..., where=...)    -> every { id, type, value }, page after page
    door.write([{id, type, value, expected?}], key)  -> the door's receipt

A busy door (503, selected_owner_unavailable) and a call whose outcome is unknown are sent again with the same request
key after a growing wait. A record too big for one message comes as byte pages, joined and checked by length and BLAKE3.
"""
import base64, json, os, sys, time, urllib.error, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "conversations", "read-data"))   # packed at /opt/conversations
from content_identity import content_hash  # noqa: E402  (BLAKE3 "1f:<hex>", standard library only)

PROTOCOL = "2025-06-18"
BUSY_RETRIES = 5
FIRST_WAIT = 0.2
PAGE = 999

WORDS = {
    "current_workspace_rights_refused": "This tool may not reach those records.",
    "original_input_refused": "The records door refused the request as written.",
    "original_workspace_source_unavailable": "The person's records cannot be reached right now.",
    "selected_owner_unavailable": "The person's records stayed busy; try again shortly.",
    "capability_gone": "This run's records door has closed.",
    "original_command_conflict": "The records changed while this tool was running. Read them again before continuing.",
    "refused": "The records door refused the call.",
}


class DoorError(Exception):
    def __init__(self, code, message, outcome=None):
        super().__init__(message)
        self.code, self.outcome = code, outcome


def _answer_of(text, content_type):
    if "text/event-stream" not in (content_type or ""):
        return json.loads(text)
    data = [line for line in text.split("\n") if line.startswith("data:")]
    if not data:
        raise DoorError("no_answer", "The records door sent an empty event stream.")
    return json.loads(data[-1][5:].strip())


class RecordsDoor:
    def __init__(self, url, resource, capability, post=None, wait=time.sleep):
        if not all(isinstance(x, str) for x in (url, resource, capability)):
            raise DoorError("no_door", "This run was not handed a records door.")
        self.url, self.resource, self._capability = url, resource, capability
        self._post = post or self._urllib_post
        self._wait = wait

    @classmethod
    def open(cls, descriptor=3, **kw):
        try:
            chunks = []
            while True:
                b = os.read(descriptor, 1 << 16)
                if not b:
                    break
                chunks.append(b)
        except OSError:
            raise DoorError("no_door", "This run was not handed a records door (its row declares invoke.records).")
        d = json.loads(b"".join(chunks).decode("utf-8").strip().splitlines()[0])
        return cls(d.get("url"), d.get("resource"), d.get("capability"), **kw)

    def _urllib_post(self, body, headers):
        # the door is on loopback: never through the run's proxy
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with opener.open(req, timeout=600) as r:
                return r.status, r.headers.get("content-type"), r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("content-type"), e.read().decode("utf-8", "replace")

    def _once(self, method, inp, key):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "run_resource_operation", "arguments": {"address": self.resource, "method": method, "request_key": key, "input": inp}}}).encode()
        headers = {"authorization": f"Bearer {self._capability}", "content-type": "application/json",
                   "accept": "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL}
        for attempt in range(BUSY_RETRIES + 1):
            again = attempt < BUSY_RETRIES
            status, ctype, text = self._post(body, headers)
            if status == 503 and again:
                self._wait(FIRST_WAIT * 2 ** attempt)
                continue
            if status == 401:
                raise DoorError("capability_gone", WORDS["capability_gone"])
            if status >= 400:
                raise DoorError(f"http_{status}", f"The records door answered {status}.")
            answer = _answer_of(text, ctype)
            if answer.get("error"):
                raise DoorError("rpc_error", str(answer["error"].get("message", WORDS["refused"])))
            result = answer.get("result") or {}
            if not result.get("isError"):
                return result.get("structuredContent")
            sc = result.get("structuredContent") or {}
            code, outcome = sc.get("code", "refused"), sc.get("outcome")
            if (code == "selected_owner_unavailable" or outcome == "unknown") and again:
                self._wait(FIRST_WAIT * 2 ** attempt)
                continue
            raise DoorError(code, WORDS.get(code, WORDS["refused"]), outcome)

    def call(self, method, inp, key=None):
        """One operation; byte pages are read on with the same request key, joined and checked."""
        key = key or f"{method}:{uuid.uuid4()}"
        answer = self._once(method, inp, key)
        page = (answer or {}).get("byte_page") if isinstance(answer, dict) else None
        if not page:
            return answer
        total, digest, parts, joined = page["total"], page["blake3"], [], 0
        while True:
            if page["offset"] != joined or page["total"] != total or page["blake3"] != digest:
                raise DoorError("byte_pages_changed", f"The door's byte pages do not follow on (offset {page['offset']} after {joined} bytes).")
            part = base64.b64decode(page["base64"])
            parts.append(part)
            joined += len(part)
            if page.get("next_after_byte") is None:
                break
            page = (self._once(method, {**inp, "after_byte": page["next_after_byte"]}, key) or {}).get("byte_page")
            if not page:
                raise DoorError("byte_pages_changed", "The door stopped answering byte pages before the last one.")
        whole = b"".join(parts)
        if len(whole) != total or content_hash(whole) != f"1f:{digest}":
            raise DoorError("byte_pages_changed", "The joined byte pages are not the answer the door hashed; the value changed between calls.")
        return json.loads(whole.decode("utf-8"))

    def read(self, type_, id_):
        r = self.call("records:read", {"id": id_, "type": type_})
        v = (r or {}).get("value")
        return v

    def list(self, type_, prefix=None, where=None, fields=None):
        after = None
        while True:
            inp = {"type": type_, "limit": PAGE}
            if prefix is not None:
                inp["prefix"] = prefix
            if where:
                inp["where"] = where
            if fields is not None:
                inp["fields"] = fields
            if after is not None:
                inp["after"] = after
            page = self.call("records:list", inp) or {}
            for rec in page.get("records") or []:
                yield rec
            after = page.get("next")
            if after is None:
                return

    def write(self, records, key):
        return self.call("records:write", {"records": records}, key)
