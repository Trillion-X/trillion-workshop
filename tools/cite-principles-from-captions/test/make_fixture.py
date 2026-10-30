"""Writes the synthetic inputs the tests use under the folder given: a captions folder of five made-up videos from two made-up channels,
a views table, a terms file, working rows of principles, and the person's own grouping and stage names."""
import json
import os
import sys

work = sys.argv[1]
captions = os.path.join(work, "captions")
os.makedirs(captions)

LINES = {
    "vidA1": ["welcome to the garden channel", "you have to water the soil before you plant anything", "the secret is patience with every seed",
              "most gardeners never wait for the soil to settle", "always test the water and never guess the soil", "the key is a small garden you look at daily",
              "if you want a big harvest start with one bed", "the reason plants fail is water and light"],
    "vidA2": ["today we talk about weeds", "weeds are just plants in the wrong place", "pull them before they seed", "thanks for watching"],
    "vidA3": ["quick tip for soil", "water the soil in the morning"],
    "vidB1": ["hello and welcome back", "the best way to grow tomatoes is to feed the soil", "you need to water at the base of the plant",
              "the formula is sun, water and time", "the thing that matters is the garden you actually visit", "never plant too close together",
              "the goal is a garden that looks after itself", "that is the whole idea"],
    "vidB2": ["a short story about a gardener", "she planted one seed and watched it daily"],
}
INFO = {
    "vidA1": ("Channel Alpha", "How to plan a garden", 1000, 600, "video"),
    "vidA2": ("Channel Alpha", "Weeds", 100, 300, "video"),
    "vidA3": ("Channel Alpha", "Soil tip", 50, 20, "short"),
    "vidB1": ("Channel Beta", "Growing tomatoes", 4000, 900, "video"),
    "vidB2": ("Channel Beta", "A gardener", 40, 400, "video"),
}
for video, lines in LINES.items():
    channel, title, views, duration, kind = INFO[video]
    info = {"id": video, "channel": channel, "title": title, "view_count": views, "duration": duration, "upload_date": "20260101",
            "description": "made up", "chapters": []}
    if kind == "short":
        info["media_type"] = "short"
    with open(os.path.join(captions, video + ".info.json"), "w") as handle:
        json.dump(info, handle)
    events = [{"tStartMs": i * 5000, "segs": [{"utf8": line}]} for i, line in enumerate(lines)]
    with open(os.path.join(captions, video + ".en.json3"), "w") as handle:
        json.dump({"events": events}, handle)
# a video with an info file and no captions
with open(os.path.join(captions, "vidNone.info.json"), "w") as handle:
    json.dump({"id": "vidNone", "channel": "Channel Beta", "title": "No captions", "view_count": 5, "duration": 100}, handle)
# a caption file for a video that is not in the corpus, found through --caption-files
extra = os.path.join(work, "more", "vidX")
os.makedirs(extra)
with open(os.path.join(extra, "vidX.en-orig.json3"), "w") as handle:
    json.dump({"events": [{"tStartMs": 12500, "segs": [{"utf8": "Next one here, it's the Riley’s case"}]}]}, handle)

with open(os.path.join(work, "views.tsv"), "w") as handle:
    handle.write("channel\tkind\tviews\n" + "\n".join(f"{c}\t{k}\t{v}" for c, k, v in [
        ("Channel Alpha", "video", 1000), ("Channel Alpha", "video", 100), ("Channel Alpha", "short", 50),
        ("Channel Beta", "video", 4000), ("Channel Beta", "video", 40), ("Channel Beta", "video", "n/a")]) + "\n")
with open(os.path.join(work, "terms.json"), "w") as handle:
    json.dump({"topic": "garden|soil|water|seed|plant", "title": "garden|soil", "advice": ["you have to", "you need to", "the secret", "the key", "always", "never"]}, handle)

rows = [
    {"id": "R-1", "principle": "Water the soil before you plant.", "kind": "stated", "lanes": ["soil", "care"], "paraphrase": "Water first.",
     "sources": [{"video": "vidA1", "t": 5, "quote": "you have to water the soil before you plant anything"}],
     "test": "Is the soil wet?", "do_it": "Water it.", "transfer": "A balcony pot."},
    {"id": "R-2", "principle": "Feed the soil.", "kind": "stated", "lanes": ["soil", "feeding"],
     "sources": [{"video": "vidB1", "t": 5, "quote": "the best way to grow tomatoes is to feed the soil"}, {"video": "vidB1", "t": 5, "quote": "The best way to grow tomatoes is to feed the soil"}],
     "test": "Was compost added?", "do_it": "Add compost.", "transfer": "A window box."},
    {"id": "R-3", "principle": "Pull weeds before they seed.", "kind": "demonstrated", "lanes": ["weeds"],
     "sources": [{"video": "vidA2", "t": 10, "quote": "pull them before they seed"}],
     "demonstrated_in": [{"video": "vidA2", "t": 10, "how": "she pulls one"}],
     "contradicts": [{"id_or_text": "R-1 says to leave the bed alone", "how": "leave or pull"}, {"id_or_text": "someone online says weeds are fine", "how": "opinion"}],
     "test": "Any seed heads?", "do_it": "Pull.", "transfer": "A lawn."},
    {"id": "R-4", "principle": "Look at the garden daily.", "kind": "stated", "lanes": ["habit"],
     "sources": [{"video": "vidB2", "t": 5, "quote": "she planted one seed and watched it daily"}],
     "test": "Seen today?", "do_it": "Visit.", "transfer": "A street tree."},
]
os.makedirs(os.path.join(work, "rows"))
with open(os.path.join(work, "rows", "a.jsonl"), "w") as handle:
    for row in rows:
        handle.write(json.dumps(row) + "\n")
with open(os.path.join(work, "rows", "bad.jsonl"), "w") as handle:
    for row in [
        {"id": "X-1", "sources": [{"video": "vidA1", "t": 5, "quote": "you have to water the soil"}, {"video": "vidA1", "t": 5, "quote": "nobody ever said this"},
                                  {"video": "vidA1", "t": 99, "quote": "the secret is patience with every seed"}]},
        {"id": "X-2", "sources": [{"video": "vidNope", "t": 0, "quote": "anything"}, {"video": "vidX", "t": 12, "quote": "Next one here, it's the Riley's case"}, {"video": "vidX", "t": 0}]},
    ]:
        handle.write(json.dumps(row) + "\n")
    handle.write("not json\n")
with open(os.path.join(work, "lanes.json"), "w") as handle:
    json.dump({"stages": {"stage one": ["soil", "weeds"], "stage two": ["habit", "feeding"]}, "lane_names": {"care": "soil"}}, handle)
with open(os.path.join(work, "merge.json"), "w") as handle:
    json.dump({"groups": [{"ids": ["R-1", "R-2"], "text": "Look after the soil first."}], "contradictions": [["R-3", "R-4", "weeds or habit"]], "recorded_by": "the test file"}, handle)
