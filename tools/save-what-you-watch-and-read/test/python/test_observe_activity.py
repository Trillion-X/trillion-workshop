# tools/save-what-you-watch-and-read/test/python/test_observe_activity.py
#
# Proves observe_activity.py: one thing seen becomes one observation with a stable identity. The same page with the same
# words is the same revision and the same id however many times it is seen; a changed page is a new revision; a url
# gains its host and a title where none was given; a request with nothing seen is refused.
import support  # noqa: E402,F401  (read-data on the import path)

import observe_activity as oa  # noqa: E402

PAGE = {"url": "https://www.example.org/rye-bread", "text": "Rye needs a long rise."}


def test_a_url_gains_its_host_and_a_title_and_is_known_by_its_url():
    seen = oa.observe({"source_ref": "source:pages", "content": PAGE, "observed_at": "2026-01-02T08:00:00Z"})
    observation = seen["observation"]
    assert observation["native_ref"] == PAGE["url"]
    assert observation["payload"]["host"] == "example.org"
    assert observation["payload"]["title"] == PAGE["url"]
    assert observation["payload"]["observed_at"] == "2026-01-02T08:00:00Z"
    assert observation["content_revision"].startswith("1f:") and observation["id"].startswith("1f:")


def test_a_title_the_caller_gave_is_kept():
    seen = oa.observe({"source_ref": "source:pages", "content": {**PAGE, "title": "Rye bread"}})
    assert seen["observation"]["payload"]["title"] == "Rye bread"


def test_the_same_page_seen_again_is_the_same_revision_and_id_at_any_time():
    first = oa.observe({"source_ref": "source:pages", "content": PAGE, "observed_at": "2026-01-02T08:00:00Z"})
    later = oa.observe({"source_ref": "source:pages", "content": dict(PAGE), "observed_at": "2026-02-03T09:30:00Z"})
    assert first["observation"]["id"] == later["observation"]["id"]
    assert first["observation"]["content_revision"] == later["observation"]["content_revision"]


def test_changed_words_are_a_new_revision_and_a_new_id_under_the_same_native_ref():
    first = oa.observe({"source_ref": "source:pages", "content": PAGE})
    changed = oa.observe({"source_ref": "source:pages", "content": {**PAGE, "text": "Rye needs a longer rise."}})
    assert first["observation"]["native_ref"] == changed["observation"]["native_ref"]
    assert first["observation"]["content_revision"] != changed["observation"]["content_revision"]
    assert first["observation"]["id"] != changed["observation"]["id"]


def test_another_source_is_another_id_for_the_same_words():
    one = oa.observe({"source_ref": "source:pages", "content": PAGE})
    other = oa.observe({"source_ref": "source:feed", "content": PAGE})
    assert one["observation"]["id"] != other["observation"]["id"]


def test_without_a_url_the_native_ref_is_the_callers_or_the_content_identity():
    app = {"app": "Notes", "window": "Shopping list"}
    named = oa.observe({"source_ref": "source:apps", "native_ref": "window-7", "content": app})
    assert named["observation"]["native_ref"] == "window-7"
    unnamed = oa.observe({"source_ref": "source:apps", "content": app})
    assert unnamed["observation"]["native_ref"] == unnamed["observation"]["content_revision"]
    assert "host" not in unnamed["observation"]["payload"]


def test_metadata_is_kept_with_the_observation():
    seen = oa.observe({"source_ref": "source:pages", "content": PAGE, "metadata": {"tab": 3}})
    assert seen["observation"]["payload"]["metadata"] == {"tab": 3}


def test_nothing_seen_or_a_bad_time_is_refused_in_plain_words():
    for request, words in [
        ({"source_ref": "source:pages", "content": {}}, "content is required"),
        ({"content": PAGE}, "source_ref is required"),
        ({"source_ref": "s", "content": PAGE, "observed_at": "last tuesday"}, "ISO-8601"),
        ([], "one JSON object"),
    ]:
        try:
            oa.observe(request)
        except oa.Refusal as refusal:
            assert words in str(refusal)
        else:
            raise AssertionError(f"{request} was not refused")


def test_host_of_drops_a_leading_www_and_survives_a_bad_url():
    assert oa.host_of("https://www.example.org/x") == "example.org"
    assert oa.host_of("https://shop.example.org/x") == "shop.example.org"
    assert oa.host_of("not a url") == ""
    assert oa.host_of("http://[bad") == ""
