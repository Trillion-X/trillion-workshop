import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "do-work/process-scripts/decide-source-message.py"
spec = importlib.util.spec_from_file_location("decide_source_message", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

MESSAGE_ID = "msg_01a0d190-9a34-7c81-a21b-f74532390a13"
CANDIDATE = {
    "record_ref": f"request:source:codex:{MESSAGE_ID}",
    "source_ref": "source:codex",
    "native_message_ref": MESSAGE_ID,
    "atom_ref": "atom:original",
    "origin_ref": "human-root-session",
    "text": "Build automatic message intake",
    "at": "2026-09-24T03:58:29.941Z",
}
OWNER = {"id": "ai-agent-profile:founder-operator", "status": "available"}
CLAIM_TIME = "2026-09-24T09:25:00Z"


def request(disposition="disposition:request", owner=OWNER, candidate=CANDIDATE):
    return {
        "candidate": candidate,
        "model_result": {"status": "completed", "items": [{
            "disposition_ref": disposition, "confidence": 0.95,
            "reason": "Founder asked for this work.",
            "acceptance_criteria": ["One owned task is visible."],
        }]},
        "owner_readback": owner,
    }


class DecisionTests(unittest.TestCase):
    def test_explicit_request_has_one_absent_current_write_and_owned_task(self):
        result = module.plan(request(), now=CLAIM_TIME)
        self.assertEqual(result["disposition_ref"], "disposition:request")
        self.assertEqual(len(result["writes"]), 1)
        self.assertEqual(result["writes"][0]["expected_current"], {"payload_hash_base64": None})
        self.assertEqual(result["tasks"][0]["assigned_to"], OWNER["id"])
        self.assertEqual(result["tasks"][0]["task_id"], CANDIDATE["record_ref"])
        self.assertEqual(result["effect_class"], "owner-routed")
        self.assertEqual(result["claim_writes"][0]["payload"]["status"], "pending-start")
        self.assertEqual(result["claim_writes"][0]["payload"]["claimed_at"], CLAIM_TIME)
        self.assertEqual(result["claim_writes"][1]["payload"]["assignedTo"], [module.ROUTED_WORKER_ID])
        self.assertEqual(result["start"]["workerRecordRef"], module.ROUTED_WORKER_REF)
        self.assertEqual(module.plan(request(), now=CLAIM_TIME), result)

    def test_private_local_task_gets_one_stable_assigned_work_claim_and_start(self):
        value = request()
        value["model_result"]["items"][0]["effect_class"] = "private-local"
        first = module.plan(value)
        self.assertEqual(len(first["claim_writes"]), 2)
        self.assertEqual(first["claim_writes"][0]["expected_current"], {"payload_hash_base64": None})
        self.assertEqual(first["claim_writes"][1]["payload"]["assignedTo"], [module.SAFE_WORKER_ID])
        self.assertEqual(first["start"]["sourceRecordRef"],
                         f'{CANDIDATE["record_ref"]}:assigned-work-source')
        replay = request(owner=None)
        replay["model_result"] = None
        replay["existing_request"] = first["writes"][0]["payload"]
        replay["existing_task"] = first["tasks"][0]
        replay["existing_claim"] = first["claim_writes"][0]["payload"]
        second = module.plan(replay)
        self.assertEqual(second["writes"], [])
        self.assertEqual(second["tasks"], [])
        self.assertEqual(second["claim_writes"], [])
        self.assertEqual(second["start"], first["start"],
                         "a lost start result retries the exact same assigned-work identity")
        replay["existing_session"] = {"task_ref": CANDIDATE["record_ref"],
                                      "session_id": "session:already-started"}
        self.assertIsNone(module.plan(replay)["start"],
                          "a verified session binding suppresses another start")
        with self.assertRaises(ValueError):
            module.plan({**value, "candidate": {**CANDIDATE, "origin_ref": "agent-child-session"}})

    def test_owner_routed_replay_reuses_one_start_identity(self):
        first = module.plan(request(), now=CLAIM_TIME)
        replay = request(owner=None)
        replay["model_result"] = None
        replay["existing_request"] = first["writes"][0]["payload"]
        replay["existing_task"] = first["tasks"][0]
        replay["existing_claim"] = first["claim_writes"][0]["payload"]
        second = module.plan(replay)
        self.assertEqual(second["claim_writes"], [])
        self.assertEqual(second["start"], first["start"])
        replay["existing_session"] = {"task_ref": CANDIDATE["record_ref"]}
        self.assertIsNone(module.plan(replay)["start"])

    def test_context_is_recorded_without_task(self):
        result = module.plan(request("disposition:context"))
        self.assertEqual(len(result["writes"]), 1)
        self.assertEqual(result["tasks"], [])
        self.assertIsNone(result["writes"][0]["payload"]["task_ref"])

    def test_missing_answer_or_owner_is_retryable(self):
        absent_answer = request()
        absent_answer["model_result"] = None
        self.assertEqual(module.plan(absent_answer)["writes"], [])
        self.assertEqual(module.plan(absent_answer)["tasks"], [])
        self.assertEqual(module.plan(request(owner=None))["writes"], [])
        self.assertEqual(module.plan(request(owner=None))["tasks"], [])

    def test_child_copy_cannot_be_admitted(self):
        with self.assertRaises(ValueError):
            module.plan(request(candidate={**CANDIDATE, "origin_ref": "agent-child-session"}))

    def test_forged_record_identity_cannot_be_admitted(self):
        with self.assertRaises(ValueError):
            module.plan(request(candidate={**CANDIDATE, "record_ref": "request:other"}))

    def test_unreliable_confidence_is_retryable(self):
        value = request()
        value["model_result"]["items"][0]["confidence"] = float("nan")
        self.assertEqual(module.plan(value)["writes"], [])

    def test_request_replay_repairs_missing_task_without_second_request(self):
        first = module.plan(request())
        replay = request(owner=None)
        replay["model_result"] = None
        replay["existing_request"] = first["writes"][0]["payload"]
        repair = module.plan(replay)
        self.assertEqual(repair["writes"], [])
        self.assertEqual(len(repair["tasks"]), 1)
        replay["existing_task"] = repair["tasks"][0]
        self.assertEqual(module.plan(replay)["tasks"], [])

    def test_conflicting_existing_request_is_rejected(self):
        value = request()
        value["existing_request"] = {"record_ref": CANDIDATE["record_ref"], "source_ref": "source:other"}
        with self.assertRaises(ValueError):
            module.plan(value)

    def test_replay_rejects_changed_observed_message(self):
        first = module.plan(request())["writes"][0]["payload"]
        for change in ({"atom_ref": "atom:different"},
                       {"content_revision": "1f:different"}):
            value = request(candidate={**CANDIDATE, **change})
            value["existing_request"] = first
            with self.subTest(change=change), self.assertRaisesRegex(
                    ValueError, "existing Request conflicts with source identity"):
                module.plan(value)

    def test_unrelated_existing_task_cannot_suppress_or_rebind_source_task(self):
        value = request()
        value["existing_task"] = {
            "task_id": "task:unrelated", "task_number": "task:unrelated"
        }
        with self.assertRaisesRegex(ValueError, "existing Task conflicts with source identity"):
            module.plan(value)


if __name__ == "__main__":
    unittest.main()
