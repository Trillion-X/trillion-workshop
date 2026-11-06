"""A records door in memory that answers the run's JSON-RPC calls as the engine's door does (records:read, records:list
with type/prefix/where/limit/after, records:write with expected), with byte pages for a value larger than page_bytes.
Made-up records only."""
import base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
from records_door import RecordsDoor, content_hash  # noqa: E402


class StandInDoor:
    def __init__(self, records=None, page_bytes=None, busy=0):
        self.records = dict(records or {})        # id -> (type, value)
        self.page_bytes = page_bytes
        self.busy = busy
        self.calls = []
        self.writes = []

    def door(self):
        return RecordsDoor("http://127.0.0.1:1/door", "@own-records", "made-up-capability", post=self.post, wait=lambda s: None)

    def post(self, body, headers):
        assert headers["authorization"] == "Bearer made-up-capability"
        if self.busy:
            self.busy -= 1
            return 503, "application/json", ""
        msg = json.loads(body)
        args = msg["params"]["arguments"]
        method, inp = args["method"], args["input"]
        self.calls.append(method)
        try:
            out = getattr(self, method.replace("records:", "op_"))(inp)
        except Conflict:
            return 200, "application/json", json.dumps({"result": {"isError": True, "structuredContent": {"code": "original_command_conflict", "outcome": "not_started"}}})
        text = json.dumps(out)
        if self.page_bytes and len(text) > self.page_bytes:
            data = text.encode()
            at = inp.get("after_byte", 0)
            part = data[at:at + self.page_bytes]
            end = at + len(part)
            out = {"byte_page": {"total": len(data), "blake3": content_hash(data)[3:], "offset": at, "length": len(part),
                                 "base64": base64.b64encode(part).decode(), "next_after_byte": end if end < len(data) else None}}
        return 200, "application/json", json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": out}})

    def op_read(self, inp):
        t, v = self.records.get(inp["id"], (None, None))
        return {"id": inp["id"], "type": inp["type"], "value": v if t == inp["type"] else None}

    def op_list(self, inp):
        ids = sorted((i for i, (t, _) in self.records.items() if t == inp["type"] and i.startswith(inp.get("prefix") or "")), reverse=True)
        where = inp.get("where") or {}
        ids = [i for i in ids if all(self.records[i][1].get(k) == v for k, v in where.items())]
        if inp.get("after"):
            ids = [i for i in ids if i < inp["after"]]
        page = ids[:inp.get("limit", 999)]
        return {"records": [{"id": i, "type": inp["type"], "value": self.records[i][1]} for i in page],
                "next": page[-1] if len(ids) > len(page) else None}

    def op_write(self, inp):
        for r in inp["records"]:
            if "expected" in r:
                held = self.records.get(r["id"])
                want = r["expected"]
                if (want is None and held is not None) or (want is not None and (held is None or held != (want["type"], want["value"]))):
                    raise Conflict()
        for r in inp["records"]:
            if r["value"] is None:
                self.records.pop(r["id"], None)
            else:
                self.records[r["id"]] = (r["type"], json.loads(json.dumps(r["value"])))
        self.writes.append(len(inp["records"]))
        return {"changed": len(inp["records"]), "write_count": len(inp["records"])}


class Conflict(Exception):
    pass
