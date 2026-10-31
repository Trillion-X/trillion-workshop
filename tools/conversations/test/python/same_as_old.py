"""Comparing two decoders on what a person keeps from a decoded export, and making the fixtures that hold the new
reader to what the decoders it replaced gave.

`projection` reduces a decoded export to each thread's id and title, each atom's native id, kind, words, time and
speaker, and how many things were rejected.

`make_fixtures(old_packages_folder)` is run once, by a person who has the old decoder packages on disk (see
test_same_as_old.py): it loads each old decoder with its own mapper (read-only), decodes each made-up export below
(each is a file name and the file's text), and returns the export and the old answer for fixtures/old_outputs.json."""
import base64
import importlib.util
import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
OBSERVATION = {"source_ref": "source:proof", "batch_ref": "batch:proof", "observed_at": "2026-01-01T00:00:00Z"}

SLACK = {"self_id": "U1", "channels": [{"id": "C1", "name": "bakery-orders", "messages": [
    {"ts": "1700000000.000100", "user": "U1", "text": "Fresh rye is up"},
    {"ts": "1700000060.000200", "user": "U2", "user_profile": {"real_name": "Rosa"}, "text": "Two loaves please"}]}]}

SIGNAL = {"self_id": "+15550100", "threads": [{"id": "thread-1", "title": "Bakery group", "messages": [
    {"id": "msg1", "timestamp": 1700000000000, "from": "rosa", "body": "Fresh rye is up"},
    {"id": "msg2", "timestamp": 1700000001000, "from": "+15550100", "body": "Two loaves please"}]}]}

SESSION_LINES = [
    {"role": "session_meta", "platform": "x"},
    {"role": "user", "content": "<@123> What is on today?", "timestamp": "2026-08-01T09:00:00Z"},
    {"role": "tool", "content": "ignored"},
    {"role": "assistant", "content": "Two meetings.", "timestamp": "2026-08-01T09:00:05Z"},
    {"role": "assistant", "content": "   ", "timestamp": "2026-08-01T09:00:06Z"},
]


def projection(result):
    threads = sorted((str(t.get("session_id") or t.get("native_ref")), t.get("title")) for t in result["threads"])
    atoms = sorted(
        (str(a.get("native_ref")), str(a.get("kind")), (a.get("content") or {}).get("text") or "",
         str(a.get("at")), json.dumps(a.get("speaker_ref"), sort_keys=True))
        for a in result["atoms"])
    return {"threads": [list(t) for t in threads], "atoms": [list(a) for a in atoms],
            "rejections": len(result["rejections"])}


def _module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _cases():
    """(source id, old package, old script, file name, file text) for each made-up export."""
    def of(file):
        return _module("t_" + file, HERE / ("test_source_" + file + ".py"))

    mail = of("mail_message")
    gmail = of("gmail_page")
    events = [
        {"timestamp": "2026-06-21T00:00:00Z", "type": "user", "content": "hello"},
        {"timestamp": "2026-06-21T00:00:01Z", "message": {"role": "assistant", "content": "hi, how can I help"}},
    ]
    web = of("web_conversation_capture")
    chat_db = pathlib.Path(of("imessage_database")._fixture_db()).read_bytes()
    page = {"historyId": "h123", "messages": [
        gmail._msg("m1", "t1", "Rosa <rosa@example.com>", "Me <" + gmail.ME + ">", "Hello", body_text="fresh rye is up",
                   internal_ms=1_700_000_000_000),
        gmail._msg("m2", "t1", "Me <" + gmail.ME + ">", "rosa@example.com", "Re: Hello", body_text="two loaves please",
                   internal_ms=1_700_000_060_000)]}
    return [
        ("slack-messages", "slack-messages-decoder", "decode-slack-messages.py", "export.json", json.dumps(SLACK)),
        ("signal-messages", "signal-messages-decoder", "decode-signal-messages.py", "export.json", json.dumps(SIGNAL)),
        ("telegram-messages", "telegram-messages-decoder", "decode-telegram-messages.py", "export.json",
         json.dumps(of("telegram_messages").SNAPSHOT)),
        ("discord-messages", "discord-messages-decoder", "decode-discord-messages.py", "export.json",
         json.dumps(of("discord_messages").SNAPSHOT)),
        ("instagram-direct-messages", "instagram-dm-decoder", "decode-instagram-dm.py", "export.json",
         json.dumps(of("instagram_direct_messages").SNAPSHOT)),
        ("whatsapp-messages", "whatsapp-web-decoder", "decode-whatsapp-web.py", "export.json",
         json.dumps(of("whatsapp_messages").SNAPSHOT)),
        ("gemini-cli-logs", "gemini-logs-decoder", "decode-gemini-logs.py", "logs.json",
         json.dumps(of("gemini_cli_logs").FIXTURE)),
        ("agent-session-lines", "hermes-session-decoder", "decode-hermes-session.py", "20260801_a1.jsonl",
         "".join(json.dumps(line) + "\n" for line in SESSION_LINES)),
        ("agent-session-events", "jsonl-session-decoder", "decode-jsonl-session.py", "session.jsonl",
         "".join(json.dumps(event) + "\n" for event in events)),
        ("mail-message", "rfc5322-mail-decoder", "decode-rfc5322-mail.py", "message.eml",
         mail._message().as_string(), mail.DESC),
        ("gmail-page", "gmail-mailbox-decoder", "decode-gmail-mailbox.py", "page.json", json.dumps(page), gmail.DESC),
        ("imessage-database", "imessage-chatdb-decoder", "decode-imessage-chatdb.py", "chat.db", chat_db,
         {"display_mark_ref": "mark:imessage"}),
        ("web-conversation-capture", "web-conversation-decoder", "decode-web-conversations.py", "snapshot.json",
         json.dumps(web.snapshot()), web.DESC, json.dumps(_with_old_binding(web.snapshot()))),
    ]


def observation_of(descriptor, path):
    """The observation for a file; a run that names its source (a captured web chat) gets that name."""
    return {**OBSERVATION, "source_ref": descriptor.get("source_ref", OBSERVATION["source_ref"]), "native_ref": str(path)}


def decode_new(support, fixture, path):
    """The new reader's answer for a fixture file (a captured web chat page has its own reader)."""
    descriptor = fixture.get("descriptor") or {}
    observation = observation_of(descriptor, path)
    if fixture["source"] == "web-conversation-capture":
        import read_web_capture
        return read_web_capture.decode(observation, support.row(fixture["source"]), descriptor)
    return support.source(fixture["source"]).decode(observation, descriptor)


def _with_old_binding(snapshot):
    """The same capture with the binding fields under the names the old decoder required (the new reader names them
    captured_by, surface and authorization, and asks for no isolation observation)."""
    binding = snapshot["capture_binding"]
    snapshot["capture_binding"] = {
        "task_ref": binding["captured_by"], "surface_ref": binding["surface"],
        "isolation_observation_ref": "observation:fixture", "authorization_ref": binding["authorization"]}
    return snapshot


def _stored(file_text):
    """How a fixture keeps the file: its text, or its bytes in base64 when it is not text."""
    if isinstance(file_text, bytes):
        return {"file_b64": base64.b64encode(file_text).decode("ascii")}
    return {"file_text": file_text}


def file_bytes(fixture):
    """The bytes of a fixture file."""
    if "file_b64" in fixture:
        return base64.b64decode(fixture["file_b64"])
    return fixture["file_text"].encode("utf-8")


def make_fixtures(old_packages):
    """[{source, file_name, file_text, old}] for each made-up export, from the old decoders in `old_packages`."""
    old_packages = pathlib.Path(old_packages)
    fixtures = []
    mapper = str(old_packages / "transcript-mapper/do-work/process-scripts")
    sys.path.insert(0, mapper)
    try:
        for source_id, package, script, file_name, file_text, *rest in _cases():
            descriptor = rest[0] if rest else {}
            old_text = rest[1] if len(rest) > 1 else file_text
            sys.modules.pop("transcript_mapper", None)
            scripts = old_packages / package / "do-work/process-scripts"
            sys.path.insert(0, str(scripts))
            try:
                old = _module("old_" + source_id.replace("-", "_"), scripts / script)
            finally:
                sys.path.remove(str(scripts))
            with tempfile.TemporaryDirectory() as folder:
                path = pathlib.Path(folder) / file_name
                path.write_bytes(old_text if isinstance(old_text, bytes) else old_text.encode("utf-8"))
                answer = old.decode(observation_of(descriptor, path), descriptor)
            fixtures.append({"source": source_id, "file_name": file_name, **_stored(file_text), "descriptor": descriptor,
                             "old": projection(answer)})
    finally:
        sys.path.remove(mapper)
        sys.modules.pop("transcript_mapper", None)
    return fixtures
