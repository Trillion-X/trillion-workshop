"""Stand-in decider-2b snapshot code: an option sharing words with the state gets three times the weight of one that
does not, and the probabilities are those weights shared out. A no/yes question's yes also gains one weight for each
word the state's first line shares with the rest of it."""
from collections import namedtuple

from stand_in_words import shared

Example = namedtuple("Example", "context questions")
Q = namedtuple("Q", "text options answer")


class Decider:
    def __init__(self, path, device=None):
        self.path, self.device = path, device

    def decide(self, state, questions):
        out = []
        for q in questions:
            weights = {o: 3.0 if shared(state, o) else 1.0 for o in q["options"]}
            if list(q["options"]) == ["no", "yes"]:
                first, _, rest = state.partition("\n")
                weights["yes"] += shared(first, rest)
            total = sum(weights.values())
            probs = {o: w / total for o, w in weights.items()}
            choice = max(q["options"], key=probs.get)
            out.append({"choice": choice, "confidence": probs[choice], "probs": probs})
        return out

    def decide_batch(self, requests):
        return [self.decide(state, questions) for state, questions in requests]
