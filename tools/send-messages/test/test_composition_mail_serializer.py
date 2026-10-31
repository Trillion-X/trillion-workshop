# tools/send-messages/test/test_composition_mail_serializer.py
#
# Pure fixture proof of the send-boundary serializer contract (W3 §8.3.1):
# fixture document -> exact html/text/refs; adversarial: empty doc, media-only
# doc, 500-block doc, unknown kind (fail-open + degraded), quote-only reply,
# hidden subtree, HTML escaping, DATA-overridable kind renderers.
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT_DIR = os.path.join(os.path.dirname(HERE), "do-work")
sys.path.insert(0, SCRIPT_DIR)

_spec = importlib.util.spec_from_file_location(
    "composition_mail_serializer",
    os.path.join(SCRIPT_DIR, "composition_mail_serializer.py"))
ser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ser)

S = ser.serialize_composition_to_mail


def _t(text, kind="Text", **props):
    return {"id": f"n-{text[:8]}", "kind": kind, "props": {"text": text, **props}}


def test_fixture_document_exact_output():
    doc = [
        {"id": "h", "kind": "Heading1", "props": {"text": "Update"}},
        _t("Hello <world> & co"),
        {"id": "img", "kind": "Image",
         "props": {"fetch_ref": "cas:abc", "mime": "image/png", "text": "chart"}},
        _t("Bye"),
    ]
    out = S(doc)
    assert out["body_html"] == (
        "<h1>Update</h1>"
        "<p>Hello &lt;world&gt; &amp; co</p>"
        '<img src="cid:part-1" alt="chart">'
        "<p>Bye</p>")
    assert out["body_text"] == "Update\nHello <world> & co\nchart\nBye"
    assert out["inline_refs"] == [{"cid": "part-1", "fetch_ref": "cas:abc",
                                   "mime": "image/png"}]
    assert out["degraded"] == []


def test_empty_document():
    assert S([]) == {"body_html": "", "body_text": "", "inline_refs": [],
                     "degraded": []}


def test_media_only_document():
    out = S([{"id": "m", "kind": "Media", "props": {"fetch_ref": "cas:x",
                                                    "mime": "video/mp4"}}])
    assert out["inline_refs"] == [{"cid": "part-1", "fetch_ref": "cas:x",
                                   "mime": "video/mp4"}]
    assert 'src="cid:part-1"' in out["body_html"]
    assert out["body_text"] == ""


def test_unknown_kind_fails_open_to_text_and_degrades():
    out = S([{"id": "u1", "kind": "FancyWidget", "props": {"label": "click me"}}])
    assert out["body_html"] == "<p>click me</p>"
    assert out["body_text"] == "click me"
    assert out["degraded"][0]["kind"] == "FancyWidget"
    # unknown kind with NO text projection is still never silent
    out2 = S([{"id": "u2", "kind": "Mystery", "props": {}}])
    assert out2["body_html"] == ""
    assert out2["degraded"][0]["node_id"] == "u2"


def test_quote_only_reply_blocks():
    doc = [_t("original line one", quote=True), _t("original line two", quote=True)]
    out = S(doc)
    assert out["body_html"] == (
        "<blockquote><p>original line one</p><p>original line two</p></blockquote>")
    assert out["body_text"] == "> original line one\n> original line two"


def test_reply_mix_quote_then_new_text():
    doc = [_t("their words", quote=True), _t("my reply")]
    out = S(doc)
    assert out["body_html"] == (
        "<blockquote><p>their words</p></blockquote><p>my reply</p>")
    assert out["body_text"] == "> their words\nmy reply"


def test_hidden_subtree_skipped():
    doc = [{"id": "h", "kind": "Text", "props": {"text": "secret"},
            "visible": False,
            "children": [_t("also hidden")]},
           _t("visible")]
    out = S(doc)
    assert out["body_text"] == "visible"


def test_nested_children_document_order():
    doc = [{"id": "root", "kind": "Container", "props": {},
            "children": [_t("first"), _t("second")]}]
    out = S(doc)
    assert out["body_text"] == "first\nsecond"


def test_500_block_document():
    doc = [_t(f"line {i:03d}") for i in range(500)]
    out = S(doc)
    assert out["body_html"].count("<p>") == 500
    assert out["body_text"].splitlines()[0] == "line 000"
    assert out["body_text"].splitlines()[-1] == "line 499"
    assert out["degraded"] == []


def test_kind_renderers_are_data_overridable():
    doc = [{"id": "x", "kind": "MyBlock", "props": {"text": "big"}}]
    out = S(doc, {"kind_renderers": {"MyBlock": "heading2"}})
    assert out["body_html"] == "<h2>big</h2>"
    assert out["degraded"] == []


def test_media_block_missing_ref_degrades_to_text():
    out = S([{"id": "m", "kind": "Image", "props": {"text": "broken image"}}])
    assert out["body_html"] == "<p>broken image</p>"
    assert out["degraded"][0]["reason"].startswith("media ref missing")


def _run_all():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    if failures:
        raise SystemExit(1)
    print("all composition-mail-serializer tests passed")


if __name__ == "__main__":
    _run_all()
