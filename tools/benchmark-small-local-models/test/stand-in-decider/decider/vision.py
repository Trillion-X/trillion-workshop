"""Stand-in decider-2b-vision snapshot code: a lettered option sharing words with the picture gets the high logit;
every question has ten letter slots, as the real model's prompt has. A no/yes question says yes as strongly as the
picture shares words with the context."""
from stand_in_words import Tensor, shared


class VisionDecisionModel:
    def __init__(self, path, grad_ckpt=False):
        self.path = path

    def to(self, *_):
        return self

    def eval(self):
        return self

    def prepare(self, pairs):
        return pairs

    def slot_logits(self, pairs):
        picture, example = pairs[0]
        rows = []
        for q in example.questions:
            if len(q.options) > 10:
                raise ValueError("more than ten lettered options")
            row = [4.0 if shared(picture.text, o) else 0.0 for o in q.options]
            if list(q.options) == ["no", "yes"]:
                row = [0.0, float(shared(picture.text, example.context))]
            rows.append(row + [-9.0] * (10 - len(row)))
        return Tensor(rows)
