"""answer_many_states.py with a made-up classifier family in place of a model, for the lifecycle tests: no weights, no
MLX, no network. `python3 -I made_up_worker.py work` reads a work request as the real program does; the model row's
`classifier` is `made-up`. Each batch is two states, and every answer is a made-up probability. A settings row's
`made_up_seconds` holds each batch back that long, so a test can stop a run while it is going."""
import os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))

import answer_many_states as A  # noqa: E402


class MadeUp:
    @staticmethod
    def check(folder):
        return ["config.json"]

    @staticmethod
    def answer(folder, questions, states, settings, on_answers, should_stop, timings):
        for i in range(0, len(states), 2):
            if should_stop():
                break
            time.sleep(settings.get("made_up_seconds", 0))
            on_answers([(s, {k: {"type": "noul", "noul": round(0.25 + s / 1000, 4)} for k in questions})
                        for s in range(i, min(i + 2, len(states)))])
        timings["answer"] = 0.01
        return "made-up"


A.FAMILIES["made-up"] = MadeUp

if __name__ == "__main__":
    sys.exit(A.main(sys.argv))
