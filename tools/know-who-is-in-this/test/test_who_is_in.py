"""The pure readers of know-who-is-in-this on made-up voices and faces: each "person" is one axis of the vector space
with a little noise, so two samples of one person are alike (about 0.98) and two people are not (about 0)."""

import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))

import who_is_in as w  # noqa: E402

AXIS = {"ann": 0, "bo": 1, "cy": 2, "di": 3}
RNG = random.Random(7)


def sample(person, size=192, noise=0.03, between=None):
    """One measurement of a made-up person: their axis, or a mix of two axes, plus noise."""
    vector = [RNG.uniform(-noise, noise) for _ in range(size)]
    for axis, weight in ((AXIS[person], 1.0),) if between is None else ((AXIS[person], 1 - between[1]), (AXIS[between[0]], between[1])):
        vector[axis] += weight
    return w.unit(vector)


def enrolled(name, kind="voice", me=False, size=192, **more):
    spec = w.KINDS[kind]
    record = w.print_record(kind, name, [sample(name.lower(), size), sample(name.lower(), size)], "She said yes on the call", me=me, **more)
    assert record["type"] == spec["record"]
    return record["value"]


def spans(*pairs):
    return [{"start": a, "end": b} for a, b in pairs]


class Enrolment(unittest.TestCase):
    def test_nobody_is_enrolled_without_consent_words(self):
        for words in ("", "   ", None):
            with self.assertRaises(w.Refused):
                w.print_record("voice", "Ann", [sample("ann")], words)

    def test_kind_name_size_and_numbers_are_checked(self):
        with self.assertRaises(w.Refused):
            w.print_record("gait", "Ann", [sample("ann")], "yes")
        with self.assertRaises(w.Refused):
            w.print_record("voice", " ", [sample("ann")], "yes")
        with self.assertRaises(w.Refused):
            w.print_record("voice", "Ann", [], "yes")
        with self.assertRaises(w.Refused):
            w.print_record("voice", "Ann", [sample("ann", size=10)], "yes")
        with self.assertRaises(w.Refused):
            w.print_record("voice", "Ann", [[0.0] * 192], "yes")
        with self.assertRaises(w.Refused):
            w.print_record("voice", "Ann", [[float("nan")] * 192], "yes")

    def test_a_second_enrolment_extends_the_person_and_keeps_every_consent(self):
        first = w.print_record("voice", "Ann Lee", [sample("ann")], "Said yes in the standup", me=True)
        again = w.print_record("voice", "Ann Lee", [sample("ann"), sample("ann")], "Said yes again on a call", existing=first["value"])
        self.assertEqual(again["id"], "voice-print:ann-lee")
        self.assertEqual(len(again["value"]["samples"]), 3)
        self.assertEqual([c["said"] for c in again["value"]["consent"]], ["Said yes in the standup", "Said yes again on a call"])
        self.assertTrue(again["value"]["me"])
        self.assertEqual(len(first["value"]["samples"]), 1, "the earlier record value is not changed")

    def test_a_face_print_is_a_different_kind_of_a_different_size(self):
        record = w.print_record("face", "Bo", [sample("bo", 128)], "Agreed to be recognised, in writing")
        self.assertEqual(record["type"], "face-print")
        with self.assertRaises(w.Refused):
            w.print_record("face", "Bo", [sample("bo", 192)], "yes")

    def test_a_heard_voice_enrols_under_every_label_it_was_heard_under(self):
        session = {"unknown": [{"id": "voice-1", "mean": sample("cy"), "also": ["voice-3"]}], "made": 3}
        mean, labels = w.heard_voice_as_sample(session, "voice-3")
        self.assertEqual(labels, ["voice-1", "voice-3"])
        self.assertEqual(len(mean), 192)
        with self.assertRaises(w.Refused):
            w.heard_voice_as_sample(session, "voice-9")


class Naming(unittest.TestCase):
    def setUp(self):
        self.prints = [enrolled("Ann", me=True), enrolled("Bo")]

    def test_one_clear_person_is_named(self):
        who, score, unsure = w.best_of(sample("ann"), self.prints, w.VOICE_RULES)
        self.assertEqual(who, {"id": "ann", "name": "Ann", "me": True})
        self.assertGreater(score, 0.9)
        self.assertEqual(unsure, [])

    def test_two_people_too_close_to_tell_are_both_listed_and_nobody_is_named(self):
        both = sample("ann", between=("bo", 0.5))
        who, _, unsure = w.best_of(both, self.prints, {**w.VOICE_RULES, "person_at_least": 0.5, "maybe_at_least": 0.4})
        self.assertIsNone(who)
        self.assertEqual({p["name"] for p in unsure}, {"Ann", "Bo"})

    def test_a_stranger_is_neither_named_nor_listed(self):
        who, _, unsure = w.best_of(sample("cy"), self.prints, w.VOICE_RULES)
        self.assertIsNone(who)
        self.assertEqual(unsure, [])

    def test_no_prints_names_nobody(self):
        self.assertEqual(w.best_of(sample("ann"), [], w.VOICE_RULES), (None, -1.0, []))


class Recordings(unittest.TestCase):
    def setUp(self):
        self.prints = [enrolled("Ann", me=True), enrolled("Bo")]

    def test_enrolled_people_are_named_and_a_stranger_is_voice_1_in_every_recording_of_the_listening(self):
        first_spans = spans((0, 4), (4, 9), (9, 14))
        first, session = w.name_spans(first_spans, [sample("ann"), sample("cy"), sample("bo")], self.prints)
        self.assertEqual([a["voice"] for a in first], ["ann", "voice-1", "bo"])
        self.assertEqual([a["who"]["name"] if a["who"] else None for a in first], ["Ann", None, "Bo"])
        second, session = w.name_spans(spans((0, 5), (5, 10)), [sample("di"), sample("cy")], self.prints, session)
        self.assertEqual([a["voice"] for a in second], ["voice-2", "voice-1"])
        self.assertEqual(session["made"], 2)

    def test_the_session_given_is_not_changed(self):
        _, session = w.name_spans(spans((0, 5)), [sample("cy")], self.prints)
        before = {"unknown": [dict(v) for v in session["unknown"]], "made": session["made"]}
        w.name_spans(spans((0, 5)), [sample("di")], self.prints, session)
        self.assertEqual(session["made"], before["made"])
        self.assertEqual(len(session["unknown"]), len(before["unknown"]))

    def test_a_stretch_that_could_not_be_measured_takes_the_voice_before_it_else_after_it(self):
        answers, _ = w.name_spans(spans((0, 5), (5, 5.5), (5.5, 9)), [sample("ann"), None, sample("bo")], self.prints)
        self.assertEqual([a["voice"] for a in answers], ["ann", "ann", "bo"])
        lead, _ = w.name_spans(spans((0, 0.4), (0.4, 5)), [None, sample("bo")], self.prints)
        self.assertEqual([a["voice"] for a in lead], ["bo", "bo"])

    def test_a_stretch_shorter_than_the_shortest_is_not_measured(self):
        answers, _ = w.name_spans(spans((0, 0.5), (0.5, 5)), [sample("cy"), sample("ann")], self.prints)
        self.assertEqual(answers[0]["who"], answers[1]["who"], "it took its neighbour answer")
        self.assertEqual(answers[0]["voice"], "ann")

    def test_an_unknown_voice_heard_too_briefly_does_not_start_a_voice_of_its_own(self):
        answers, session = w.name_spans(spans((0, 1.5), (1.5, 6)), [sample("cy"), sample("ann")], self.prints)
        self.assertEqual(session["unknown"], [])
        self.assertEqual(answers[0]["voice"], "ann")

    def test_the_stretches_of_one_voice_are_judged_together(self):
        # Alone each is half Ann and half Bo; together the voice is the one it mostly is.
        mixed = [sample("ann", between=("bo", 0.35)) for _ in range(3)]
        answers, _ = w.name_spans(spans((0, 3), (3, 6), (6, 9)), mixed, self.prints, rules={"person_at_least": 0.5, "maybe_at_least": 0.4})
        self.assertEqual({a["voice"] for a in answers}, {"ann"})

    def test_two_unknown_voices_that_grow_alike_become_one_and_keep_both_labels(self):
        session = {"unknown": [{"id": "voice-1", "mean": sample("cy"), "seconds": 10, "count": 2},
                               {"id": "voice-2", "mean": sample("cy", noise=0.04), "seconds": 5, "count": 1}], "made": 2}
        w.merge_alike(session, 0.72)
        self.assertEqual(len(session["unknown"]), 1)
        self.assertEqual(session["unknown"][0]["id"], "voice-1")
        self.assertEqual(session["unknown"][0]["also"], ["voice-2"])
        self.assertEqual(w.voice_of(session, "voice-2")["id"], "voice-1")


class Turns(unittest.TestCase):
    def test_same_voice_within_the_gap_is_one_turn_and_its_score_is_the_least_sure(self):
        segments = [{"start": 0, "end": 2, "text": "Hello"}, {"start": 3, "end": 5, "text": "there"}, {"start": 9, "end": 11, "text": "Again"}]
        who = {"id": "ann", "name": "Ann", "me": True}
        answers = [{"voice": "ann", "who": who, "score": 0.9, "unsure": []}, {"voice": "ann", "who": who, "score": 0.8, "unsure": []},
                   {"voice": "ann", "who": who, "score": 0.95, "unsure": []}]
        turns = w.speakers_of(segments, answers)
        self.assertEqual([(t["start"], t["end"], t["text"], t["score"], t["who"], t["me"]) for t in turns],
                         [(0, 5, "Hello there", 0.8, "Ann", True), (9, 11, "Again", 0.95, "Ann", True)])

    def test_labels_for_unsure_and_unknown_voices_and_a_turn_never_measured_is_unsure_of_its_score(self):
        answer = {"voice": "voice-2", "who": None, "score": 0.4, "unsure": [{"id": "ann", "name": "Ann"}, {"id": "bo", "name": "Bo"}, {"id": "cy", "name": "Cy"}]}
        self.assertEqual(w.speaker_label(answer), "Unsure (Ann, Bo or Cy?)")
        self.assertEqual(w.speaker_label({"voice": "voice-2", "who": None, "unsure": []}), "Someone (voice-2)")
        self.assertEqual(w.speaker_label({"voice": "voice-2", "who": None, "unsure": []}, {"unknown": "Voice {voice}"}), "Voice voice-2")
        segments = [{"start": 0, "end": 2, "text": "a"}, {"start": 2, "end": 4, "text": "b"}]
        answers = [{"voice": "voice-1", "who": None, "score": 0.7, "unsure": []}, {"voice": "voice-1", "who": None, "score": None, "unsure": []}]
        self.assertIsNone(w.speakers_of(segments, answers)[0]["score"])


class Faces(unittest.TestCase):
    def test_a_face_is_named_by_the_same_rule_and_a_missing_vector_is_nobody(self):
        prints = [enrolled("Ann", "face", size=128), enrolled("Bo", "face", size=128)]
        named = w.name_faces([sample("ann", 128), sample("cy", 128), None], prints)
        self.assertEqual(named[0]["who"]["name"], "Ann")
        self.assertIsNone(named[1]["who"])
        self.assertEqual(named[2], {"who": None, "score": None, "unsure": []})


if __name__ == "__main__":
    unittest.main()
