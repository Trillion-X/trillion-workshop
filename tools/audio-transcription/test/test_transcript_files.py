"""The transcript-file readers in do-work/ (read_transcript_files, pick_transcript_files, caption_transcripts,
find_whisper_quotes, show_segments) and judge --durations / text --header, run as commands on made-up files."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DO = os.path.join(HERE, "..", "do-work")


def run(script, *argv):
    out = subprocess.run([sys.executable, "-I", os.path.join(DO, script), *argv], capture_output=True, text=True)
    if out.returncode:
        raise AssertionError(out.stderr)
    return out.stdout, json.loads(out.stdout.strip().split("\n")[-1])["result"]


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return path


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def load(path):
    return json.loads(read(path))


SRT = "1\n00:00:01,500 --> 00:00:03,000\nHello &amp; welcome\n\n2\n00:00:04,000 --> 00:00:06,250\nto the   river walk\n"
VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.5\nfirst cue\n\n00:00:02.500 --> 00:00:05.000\nsecond cue\n"
HASH = "source: walk-take-2.mov\n\n## 0:00:00.000 - 0:00:04.000\nWe start at the gate.\n\n## 0:00:04.000 - 0:00:09.500\nThen up the hill.\n"
TC = "00:00:00:00 - 00:00:02:12\nSpeaker 1\nA timecode line.\n00:00:02:12 - 00:00:05:00\nSpeaker 1\nAnother one.\n"
JSON = {"source": "lake.wav", "duration": 7.0, "segments": [
    {"text": " Calm water ", "start": 0.0, "end": 2.0, "words": [{"word": " Calm", "start": 0.0, "end": 0.8}, {"word": " water", "start": 0.9, "end": 2.0}]}]}


class ReadFiles(unittest.TestCase):
    def test_each_format_reads_into_the_words_shape(self):
        with tempfile.TemporaryDirectory() as work:
            cases = {"a.srt": SRT, "a.vtt": VTT, "a.txt": HASH, "b.txt": TC, "a.json": json.dumps(JSON), "c.txt": "just  words\nno times"}
            got = {}
            for name, text in cases.items():
                _, result = run("read_transcript_files.py", "read-file", "--file", write(os.path.join(work, name), text),
                                "--out", os.path.join(work, name + ".words.json"))
                got[name] = load(os.path.join(work, name + ".words.json"))
                self.assertEqual(result["timing"], got[name]["timing"])
            self.assertEqual(got["a.srt"]["segments"], [{"text": "Hello & welcome", "start": 1.5, "end": 3.0},
                                                        {"text": "to the river walk", "start": 4.0, "end": 6.25}])
            self.assertEqual((got["a.srt"]["timing"], got["a.srt"]["duration"]), ("segment", 6.25))
            self.assertEqual(got["a.vtt"]["segments"][0]["end"], 2.5)
            self.assertEqual(got["a.txt"]["source"], "walk-take-2.mov")
            self.assertEqual([s["end"] for s in got["a.txt"]["segments"]], [4.0, 9.5])
            self.assertEqual(got["b.txt"]["segments"][0], {"text": "A timecode line.", "start": 0.0, "end": 2.5})
            self.assertEqual(got["a.json"]["words"], [{"text": "Calm", "start": 0.0, "end": 0.8}, {"text": "water", "start": 0.9, "end": 2.0}])
            self.assertEqual((got["a.json"]["timing"], got["a.json"]["duration"]), ("word", 7.0))
            self.assertEqual((got["c.txt"]["timing"], got["c.txt"]["text"]), ("none", "just words no times"))

    def test_timecode_is_read_at_the_frames_per_second_given(self):
        with tempfile.TemporaryDirectory() as work:
            run("read_transcript_files.py", "read-file", "--file", write(os.path.join(work, "t.txt"), TC), "--out",
                os.path.join(work, "t.json"), "--fps", "25")
            self.assertEqual(load(os.path.join(work, "t.json"))["segments"][0]["end"], 2.48)

    def test_read_files_reads_a_list_skips_what_is_done_or_missing(self):
        with tempfile.TemporaryDirectory() as work:
            a, b = "aa" * 32, "bb" * 32
            listing = write(os.path.join(work, "list.tsv"), "kind\text\torigin\tidentity\tbytes\tsha256\tdisplay_path\n"
                            f"srt\tsrt\tstore-one\t1f:{a}\t10\t{a}\t./walks/day1.srt\n"
                            f"raw\ttxt\tstore-one\t1f:{b}\t10\t{b}\t./walks/day2_raw.txt\n")
            write(os.path.join(work, "bytes", f"{a}.srt"), SRT)
            out = os.path.join(work, "out")
            _, result = run("read_transcript_files.py", "read-files", "--list", listing, "--bytes", os.path.join(work, "bytes"),
                            "--out-dir", out, "--root", "walks-drive", "--origin", "store-one")
            self.assertEqual(result, {"written": 1, "already_read": 0, "not_in_files": 1, "by_format_and_timing": {"srt segment": 1}})
            doc = load(os.path.join(out, f"{a}.words.json"))
            self.assertEqual({k: doc[k] for k in ("source", "display_path", "root", "origin", "identity", "kind")},
                             {"source": "./walks/day1.srt", "display_path": "./walks/day1.srt", "root": "walks-drive",
                              "origin": "store-one", "identity": f"1f:{a}", "kind": "srt"})
            _, again = run("read_transcript_files.py", "read-files", "--list", listing, "--bytes", os.path.join(work, "bytes"), "--out-dir", out)
            self.assertEqual((again["written"], again["already_read"]), (0, 1))


class PickFiles(unittest.TestCase):
    ASSETS = [
        {"root": "walks-drive", "ext": "srt", "name": "day1.srt", "display_path": "./walks/day1.srt", "sha256": "a1"},
        {"root": "walks-drive", "ext": "txt", "name": "day2_raw.txt", "display_path": "", "sha256": "b2"},
        {"root": "walks-drive", "ext": "txt", "name": "notes.txt", "display_path": "./walks/Transcripts/notes.txt", "sha256": "c3"},
        {"root": "walks-drive", "ext": "txt", "name": "shopping.txt", "display_path": "./lists/shopping.txt", "sha256": "d4"},
        {"root": "walks-drive", "ext": "mp4", "name": "transcript.mp4", "display_path": "", "sha256": "e5"},
        {"root": "other-drive", "ext": "srt", "name": "x.srt", "display_path": "", "sha256": "f6"},
        {"root": "walks-drive", "ext": "json", "name": "day3_cleaned_up.json", "display_path": "", "sha256": "g7"},
    ]
    HELD = {"aliases": {"a1": "1f:aaa"}, "files": {"1f:aaa": {"origin": "store-one", "byte_length": 120},
                                                   "1f:b2": {"origin": "store-two", "byte_length": 7}}}
    WANT = ("kind\text\torigin\tidentity\tbytes\tsha256\tdisplay_path\n"
            "srt\tsrt\tstore-one\t1f:aaa\t120\ta1\t./walks/day1.srt\n"
            "raw\ttxt\tstore-two\t1f:b2\t7\tb2\tday2_raw.txt\n"
            "transcript-named\ttxt\tmissing\t\t\tc3\t./walks/Transcripts/notes.txt\n"
            "cleaned\tjson\tmissing\t\t\tg7\tday3_cleaned_up.json\n")

    def assets(self, work):
        return write(os.path.join(work, "assets.jsonl"), "".join(json.dumps(r) + "\n" for r in self.ASSETS))

    def test_the_files_doors_answer_joins_by_alias_then_identity(self):
        with tempfile.TemporaryDirectory() as work:
            out = os.path.join(work, "list.tsv")
            _, result = run("pick_transcript_files.py", "--assets", self.assets(work), "--root", "walks-drive", "--out", out,
                            "--held", write(os.path.join(work, "held.json"), json.dumps(self.HELD)))
            self.assertEqual(read(out), self.WANT)
            self.assertEqual(result["files"], 4)
            self.assertEqual(result["by_kind_and_origin"]["transcript-named missing"], 1)

    def test_a_namespace_copy_answers_the_same(self):
        with tempfile.TemporaryDirectory() as work:
            store = os.path.join(work, "a folder with spaces", "namespace.sqlite")
            os.makedirs(os.path.dirname(store))
            db = sqlite3.connect(store)
            db.execute("create table versions (id text, resource text, body text, valid_to integer, deleted integer)")
            live = 9223372036854775807
            db.execute("insert into versions values ('12:a1', '@namespace/aliases', ?, ?, 0)", (json.dumps({"identity": "1f:aaa"}), live))
            for ident, body in self.HELD["files"].items():
                db.execute("insert into versions values (?, '@namespace/files', ?, ?, 0)", (ident, json.dumps(body), live))
            db.execute("insert into versions values ('1f:c3', '@namespace/files', ?, 5, 0)", (json.dumps({"origin": "old", "byte_length": 1}),))
            db.commit()
            db.close()
            out = os.path.join(work, "list.tsv")
            run("pick_transcript_files.py", "--assets", self.assets(work), "--root", "walks-drive", "--out", out, "--namespace-sqlite", store)
            self.assertEqual(read(out), self.WANT)


def corpus(work):
    raw = os.path.join(work, "raw")
    write(os.path.join(raw, "flat-videos.jsonl"), json.dumps({"id": "vidAAAAAAAA", "title": "Flat title", "view_count": 9, "duration": 70}) + "\n"
          + json.dumps({"id": "vidBBBBBBBB", "title": "No captions", "view_count": 3, "duration": 50}) + "\n")
    write(os.path.join(raw, "meta", "vidAAAAAAAA.meta.json"), json.dumps({"title": "How rivers bend", "upload_date": "20200101", "view_count": 12, "duration": 70, "like_count": 2}))
    events = {"events": [{"tStartMs": 0, "segs": [{"utf8": "rivers"}, {"utf8": " bend"}]}, {"tStartMs": 500},
                         {"tStartMs": 12000, "segs": [{"utf8": "\n"}]}, {"tStartMs": 20000, "segs": [{"utf8": "slowly\nover"}]},
                         {"tStartMs": 31000, "segs": [{"utf8": "  years  "}]}, {"tStartMs": 3725000, "segs": [{"utf8": "late"}]}]}
    write(os.path.join(raw, "json3", "vidAAAAAAAA.en.json3"), json.dumps(events))
    write(os.path.join(raw, "json3", "vidAAAAAAAA.en-orig.json3"), json.dumps({"events": [{"tStartMs": 0, "segs": [{"utf8": "wrong track"}]}]}))
    return raw


class CaptionTranscripts(unittest.TestCase):
    def test_the_manual_track_becomes_paragraphs_and_the_index_lists_every_video(self):
        with tempfile.TemporaryDirectory() as work:
            corpus(work)
            _, result = run("caption_transcripts.py", "--corpus", work, "--channel", "River Talks", "--source-channel", "rivertalks")
            self.assertEqual(result["rows"], 2)
            self.assertEqual(result["with_captions"], 1)
            self.assertEqual(read(os.path.join(work, "transcripts", "vidAAAAAAAA.txt")),
                             "# How rivers bend\nhttps://www.youtube.com/watch?v=vidAAAAAAAA\nChannel: River Talks\nCaptions: yt-dlp, YouTube captions\n\n"
                             "[0:00] rivers bend slowly over\n[0:31] years\n[1:02:05] late\n")
            index = read(os.path.join(work, "index.tsv")).split("\n")
            self.assertEqual(index[1].split("\t"), ["vidAAAAAAAA", "How rivers bend", "20200101", "12", "70", "2", "yes", "rivertalks", "videos", "", "3", "vidAAAAAAAA.en.json3"])
            self.assertEqual(index[2].split("\t")[:7], ["vidBBBBBBBB", "No captions", "", "3", "50", "", "no"])


class WhisperQuotes(unittest.TestCase):
    def test_a_quote_is_found_by_its_words_and_its_window_is_checked(self):
        with tempfile.TemporaryDirectory() as work:
            write(os.path.join(work, "index.tsv"), "id\tcaption_source\nwhisperone\twhisper, local\ncaptioned1\tyt-dlp\n")
            words = [{"w": w, "s": i * 10.0, "e": i * 10.0 + 0.5} for i, w in enumerate("The river, it BENDS. Then the river bends again".split())]
            write(os.path.join(work, "raw", "whisper", "whisperone.json"), json.dumps({"words": words}))
            write(os.path.join(work, "quote-check.tsv"), "video\tstamp\tquote\n"
                  "whisperone\t0:00\tthe river bends\nwhisperone\t0:00\tthe river bends\nwhisperone\t1:00\tnever said\ncaptioned1\t0:00\tskipped\n")
            out, result = run("find_whisper_quotes.py", "--corpus", work)
            self.assertIn("whisperone 0:00 word times 50.00-70.50 OUTSIDE window (hit 1 of 1) the river bends", out)
            self.assertEqual((result["quotes"], result["problems"]), (2, 2))
            _, wide = run("find_whisper_quotes.py", "--corpus", work, "--window-seconds", "60")
            self.assertEqual(wide["problems"], 1)
            self.assertTrue(wide["hits"][0]["in_window"])


class SegmentsAndJudge(unittest.TestCase):
    def test_segments_between_two_seconds(self):
        with tempfile.TemporaryDirectory() as work:
            clip = write(os.path.join(work, "c1.words.json"), json.dumps({"segments": [{"start": 1.0, "text": "in range"}, {"start": 9.0, "text": "out of range"}]}))
            out, result = run("show_segments.py", clip, "0", "5")
            self.assertEqual(out.split("\n")[0], "1 in range")
            self.assertEqual(result["segments"], [{"start": 1.0, "text": "in range"}])

    def test_judge_reads_each_recordings_length_from_a_list_and_text_takes_header_lines(self):
        with tempfile.TemporaryDirectory() as work:
            words = [{"w": f"w{i}"} for i in range(60)]
            doc = {"segments": [{"start": i * 2.0, "end": i * 2.0 + 1, "text": f"line {i}"} for i in range(35)], "words": words}
            t = write(os.path.join(work, "clipone.json"), json.dumps(doc))
            lengths = write(os.path.join(work, "index.tsv"), "id\tduration_s\nclipone\t3600\n")
            _, short = run("audio_transcription.py", "judge", "--transcript", t)
            self.assertEqual(short["rejected"], 0)
            _, long = run("audio_transcription.py", "judge", "--transcript", t, "--durations", lengths, "--duration-column", "duration_s")
            self.assertEqual(long["verdicts"][0]["reasons"], ["words per minute 1"])
            _, one = run("audio_transcription.py", "judge", "--transcript", t, "--duration", "3600")
            self.assertEqual(one["rejected"], 1)
            out = os.path.join(work, "clipone.txt")
            run("audio_transcription.py", "text", "--transcript", t, "--out", out, "--title", "Clip one", "--header", "https://example.com/v/1",
                "--header", "Captions: whisper")
            self.assertTrue(read(out).startswith("# Clip one\nhttps://example.com/v/1\nCaptions: whisper\n\n[0:00] line 0"))


if __name__ == "__main__":
    unittest.main()
