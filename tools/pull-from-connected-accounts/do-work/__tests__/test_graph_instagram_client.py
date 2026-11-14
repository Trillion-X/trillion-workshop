#!/usr/bin/env python3
# packages/instagram-dm-connector/do-work/__tests__/test_graph_instagram_client.py
#
# Offline gauntlet for the Graph-API Instagram DM path. NO network: a fake HTTP
# getter replays the EXACT live Graph JSON shapes (captured 2026-07-13 from
# graph.instagram.com/v21.0 for jibrandoesthings). Proves:
#   1. Graph JSON -> canonical thread/message contract the decoder + snapshot store
#      consume (from.id->user_id, message->text, id->item_id, ISO->epoch micros).
#   2. self_pk = me.user_id (participant/from id space).
#   3. Re-pull dedups (message_key = item_id) -> snapshot never grows on re-pull.
#   4. The thin producer delegates to the shared run_pull and writes ONE snapshot
#      file per account (SSOT with the instagrapi path's _capture_file naming).
#   5. No token bytes escape into any returned dict.
#
# Run:  python3 packages/instagram-dm-connector/do-work/__tests__/test_graph_instagram_client.py
import importlib.util
import json
import pathlib
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
DOWORK = HERE.parent

import sys
sys.path.insert(0, str(DOWORK))
from graph_instagram_client import GraphInstagramClient, _iso_to_micros
import ig_snapshot_store as store

# --- fake live Graph responses (verbatim shapes) -----------------------------
ME = {"user_id": "17841452139268435", "username": "jibrandoesthings", "id": "25592590597018471"}
CONV = {"data": [
    {"participants": {"data": [
        {"username": "jibrandoesthings", "id": "17841452139268435"},
        {"username": "jai.journeys", "id": "874954304624858"}]},
     "updated_time": "2026-07-11T00:00:23+0000",
     "id": "THREAD_A"},
    {"participants": {"data": [
        {"username": "jibrandoesthings", "id": "17841452139268435"},
        {"username": "example_user", "id": "7413740168741292"}]},
     "updated_time": "2026-07-10T12:00:00+0000",
     "id": "THREAD_B"}]}
MSGS = {
    "THREAD_A": {"data": [
        {"from": {"username": "jai.journeys", "id": "874954304624858"},
         "created_time": "2026-07-11T00:00:23+0000", "message": "hey there", "id": "MSG_A1"},
        {"from": {"username": "jibrandoesthings", "id": "17841452139268435"},
         "created_time": "2026-07-11T00:00:25+0000", "message": "", "id": "MSG_A2"}]},
    "THREAD_B": {"data": [
        {"from": {"username": "example_user", "id": "7413740168741292"},
         "created_time": "2026-07-10T12:00:00+0000", "message": "yo", "id": "MSG_B1"}]},
}

TOKEN_SENTINEL = "IGAA_SECRET_TOKEN_SHOULD_NEVER_APPEAR"


def fake_get(path, params):
    assert params.get("access_token", TOKEN_SENTINEL) == TOKEN_SENTINEL  # token flows to transport only
    if path == "me":
        return ME
    if path == "me/conversations":
        return CONV
    if path.endswith("/messages"):
        tid = path.split("/")[0]
        return MSGS[tid]
    raise AssertionError("unexpected path " + path)


def _client():
    # http_get injected -> token never reaches a real request; pass sentinel for leak test
    c = GraphInstagramClient(TOKEN_SENTINEL, http_get=lambda p, q: fake_get(p, q))
    return c


def test_iso_to_micros():
    assert _iso_to_micros("2026-07-11T00:00:23+0000") == 1783728023 * 1_000_000
    assert _iso_to_micros(1783728023000000) == 1783728023000000
    assert _iso_to_micros("") is None and _iso_to_micros(None) is None
    print("ok test_iso_to_micros")


def test_user_id_is_me_user_id():
    assert _client().user_id == "17841452139268435"
    print("ok test_user_id_is_me_user_id")


def test_canonical_thread_shape():
    threads = _client().direct_threads(amount=20, thread_message_limit=20)
    assert [t["id"] for t in threads] == ["THREAD_A", "THREAD_B"]
    a = threads[0]
    assert a["viewer_id"] == "17841452139268435"
    assert a["thread_title"] == "jai.journeys"  # the OTHER participant
    assert {u["pk"] for u in a["users"]} == {"17841452139268435", "874954304624858"}
    m0 = a["messages"][0]
    assert m0["item_id"] == "MSG_A1"           # graph id -> item_id
    assert m0["user_id"] == "874954304624858"  # from.id -> user_id
    assert m0["text"] == "hey there"           # message -> text
    assert m0["timestamp"] == 1783728023 * 1_000_000  # ISO -> epoch micros
    assert a["messages"][1]["text"] == ""      # media/empty preserved (decoder drops)
    print("ok test_canonical_thread_shape")


def test_repull_dedups_via_store():
    threads = _client().direct_threads(20, 20)
    snap = store.merge_threads(store.empty_snapshot("17841452139268435"), threads,
                               self_pk="17841452139268435")
    n1 = sum(len(t["messages"]) for t in snap["threads"])
    snap2 = store.merge_threads(snap, threads, self_pk="17841452139268435")
    n2 = sum(len(t["messages"]) for t in snap2["threads"])
    assert n1 == n2 == 3, (n1, n2)  # 2 in A + 1 in B, stable on re-pull
    print("ok test_repull_dedups_via_store")


def test_producer_writes_one_snapshot_file():
    spec = importlib.util.spec_from_file_location(
        "connect_instagram_graph", str(DOWORK / "connect-instagram-graph.py"))
    prod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prod)
    with tempfile.TemporaryDirectory() as d:
        rc = prod.main(
            ["--account", "jibrandoesthings", "--capture-dir", d],
            client_factory=_client)
        assert rc == 0, rc
        files = list(pathlib.Path(d).glob("*.json"))
        assert len(files) == 1, files
        assert files[0].name == "jibrandoesthings.json"
        snap = json.loads(files[0].read_text())
        assert snap["self_pk"] == "17841452139268435"
        assert sum(len(t["messages"]) for t in snap["threads"]) == 3
        # no token bytes in the durable snapshot
        assert TOKEN_SENTINEL not in files[0].read_text()
    print("ok test_producer_writes_one_snapshot_file")


def test_default_get_scrubs_token_on_http_error():
    # Prove the REAL getter never leaks the token when the network errors.
    # Monkeypatch urllib.request.urlopen to raise HTTPError; the token must not
    # appear in the raised GraphRequestError text.
    import urllib.error, urllib.request, io
    import graph_instagram_client as gc
    real = urllib.request.urlopen
    def boom(req, timeout=None):
        # req is a Request; its full_url must NOT carry the token (header-only)
        assert TOKEN_SENTINEL not in req.full_url, "token leaked into URL"
        assert req.get_header("Authorization") == "Bearer " + TOKEN_SENTINEL
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))
    urllib.request.urlopen = boom
    try:
        raised = None
        try:
            gc._default_http_get(gc.GRAPH_BASE, gc.GRAPH_VERSION, TOKEN_SENTINEL, "me", {"fields": "user_id"})
        except gc.GraphRequestError as e:
            raised = e
        assert raised is not None, "expected GraphRequestError"
        assert TOKEN_SENTINEL not in str(raised), "token leaked into error text"
        assert "http 401" in str(raised)
    finally:
        urllib.request.urlopen = real
    print("ok test_default_get_scrubs_token_on_http_error")


def test_no_token_leak_in_threads():
    blob = json.dumps(_client().direct_threads(20, 20))
    assert TOKEN_SENTINEL not in blob
    print("ok test_no_token_leak_in_threads")


# --- Facebook-Login surface (EAA token + ig_user_id DATA) --------------------
# Same fixtures, different edge: conversations are USER-scoped
# ({ig_user_id}/conversations) and carry platform=instagram; self id is the
# supplied ig_user_id LITERAL (no `me` lookup). Presence of the DATA fields is
# the only selector — proving the L090 shape (no profile-name branch).
IG_USER_ID = "17841452139268435"


def fake_get_fb(path, params, calls):
    calls.append((path, dict(params)))
    assert path != "me", "fb-login surface must not hit me lookup"
    if path == IG_USER_ID + "/conversations":
        assert params.get("platform") == "instagram", params
        return CONV
    if path.endswith("/messages"):
        return MSGS[path.split("/")[0]]
    raise AssertionError("unexpected path " + path)


def _fb_client(calls):
    return GraphInstagramClient(
        TOKEN_SENTINEL, http_get=lambda p, q: fake_get_fb(p, q, calls),
        ig_user_id=IG_USER_ID, platform="instagram")


def test_fb_login_user_id_is_literal_no_me_call():
    calls = []
    assert _fb_client(calls).user_id == IG_USER_ID
    assert calls == []  # literal id -> zero HTTP
    print("ok test_fb_login_user_id_is_literal_no_me_call")


def test_fb_login_user_scoped_conversations_with_platform():
    calls = []
    threads = _fb_client(calls).direct_threads(amount=20, thread_message_limit=20)
    assert [t["id"] for t in threads] == ["THREAD_A", "THREAD_B"]
    assert threads[0]["viewer_id"] == IG_USER_ID
    assert threads[0]["messages"][0]["item_id"] == "MSG_A1"
    conv_calls = [c for c in calls if c[0] == IG_USER_ID + "/conversations"]
    assert conv_calls, calls
    msg_calls = [c for c in calls if c[0].endswith("/messages")]
    assert all("platform" not in q for _, q in msg_calls)  # platform on conversations edge only
    print("ok test_fb_login_user_scoped_conversations_with_platform")


def test_producer_threads_fb_login_data_through():
    from graph_instagram_client import make_graph_client_from_token_file
    with tempfile.TemporaryDirectory() as d:
        tf = pathlib.Path(d) / "token"
        tf.write_text(TOKEN_SENTINEL, encoding="utf-8")
        c = make_graph_client_from_token_file(
            str(tf), ig_user_id=IG_USER_ID, platform="instagram",
            base="https://graph.facebook.com")
        assert c._ig_user_id == IG_USER_ID and c._platform == "instagram"
        assert c._base == "https://graph.facebook.com"
        assert c.user_id == IG_USER_ID  # literal, no network
    print("ok test_producer_threads_fb_login_data_through")


def test_default_base_is_facebook_graph():
    # The connect flow verifies pasted tokens against graph.facebook.com — the
    # client default must match what that flow mints.
    import graph_instagram_client as gc
    assert gc.GRAPH_BASE == "https://graph.facebook.com"
    print("ok test_default_base_is_facebook_graph")


def test_transport_reset_retries_then_succeeds():
    # Meta's edge transiently resets TLS (URLError) BEFORE answering. The getter
    # must retry transport failures (bounded) but fail HTTP errors immediately —
    # they are the server's answer and retrying cannot change consent.
    import urllib.error, urllib.request
    import graph_instagram_client as gc
    real = urllib.request.urlopen
    state = {"n": 0}
    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"user_id": "42"}'
    def flaky(req, timeout=None):
        state["n"] += 1
        if state["n"] < 3:
            raise urllib.error.URLError(ConnectionResetError(54, "reset"))
        return _Resp()
    urllib.request.urlopen = flaky
    sleeps = []
    try:
        out = gc._default_http_get(gc.GRAPH_BASE, gc.GRAPH_VERSION, TOKEN_SENTINEL,
                                   "me", {}, retry_sleep=sleeps.append)
        assert out == {"user_id": "42"}
        assert state["n"] == 3 and sleeps == [1, 2]
    finally:
        urllib.request.urlopen = real
    print("ok test_transport_reset_retries_then_succeeds")


def test_transport_reset_exhausts_to_scrubbed_error():
    import urllib.error, urllib.request
    import graph_instagram_client as gc
    real = urllib.request.urlopen
    def always_reset(req, timeout=None):
        raise urllib.error.URLError(ConnectionResetError(54, "reset"))
    urllib.request.urlopen = always_reset
    try:
        raised = None
        try:
            gc._default_http_get(gc.GRAPH_BASE, gc.GRAPH_VERSION, TOKEN_SENTINEL,
                                 "me", {}, transport_retries=2, retry_sleep=lambda s: None)
        except gc.GraphRequestError as e:
            raised = e
        assert raised is not None and TOKEN_SENTINEL not in str(raised)
        assert raised.status is None
    finally:
        urllib.request.urlopen = real
    print("ok test_transport_reset_exhausts_to_scrubbed_error")


if __name__ == "__main__":
    test_iso_to_micros()
    test_user_id_is_me_user_id()
    test_canonical_thread_shape()
    test_repull_dedups_via_store()
    test_producer_writes_one_snapshot_file()
    test_no_token_leak_in_threads()
    test_default_get_scrubs_token_on_http_error()
    test_fb_login_user_id_is_literal_no_me_call()
    test_fb_login_user_scoped_conversations_with_platform()
    test_producer_threads_fb_login_data_through()
    test_default_base_is_facebook_graph()
    test_transport_reset_retries_then_succeeds()
    test_transport_reset_exhausts_to_scrubbed_error()
    print("ALL graph instagram client tests passed")
