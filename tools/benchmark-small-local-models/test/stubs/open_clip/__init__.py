"""Stand-in open_clip: texts and pictures become word vectors (stand_in_words), so the most alike option is the one
sharing the picture's words."""
from stand_in_words import Tensor, vector


class Model:
    def to(self, *_):
        return self

    def eval(self):
        return self

    def encode_text(self, tokens):
        return Tensor([vector(t) for t in tokens.rows])

    def encode_image(self, batch):
        return Tensor([vector(p.text) for p in batch.rows])

    def parameters(self):
        return [Tensor([0.0] * 3)]


def create_model_from_pretrained(name):
    return Model(), lambda picture: Tensor(picture)


def get_tokenizer(name):
    return lambda texts: Tensor(list(texts))
