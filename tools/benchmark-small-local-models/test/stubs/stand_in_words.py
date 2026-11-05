"""The one rule every stand-in model here follows, so a test knows the right answer: a text or a made-up picture (a
file holding words) means the words it holds, and two things are alike by the words they share."""
WORDS = ["wide", "close", "yes", "person", "screen", "red", "blue"]


def vector(text):
    text = text.lower()
    return [text.count(w) + 0.01 for w in WORDS]


def shared(a, b):
    return sum(1 for w in WORDS if w in a.lower() and w in b.lower())


class Tensor:
    """Enough of a tensor for the scripts: nested lists (one or two deep) that move, cast, index, slice, multiply as
    matrices, transpose and iterate."""

    def __init__(self, rows):
        self.rows = rows.rows if isinstance(rows, Tensor) else rows

    def to(self, *_):
        return self

    def float(self):
        return self

    def cpu(self):
        return self

    def eval(self):
        return self

    def tolist(self):
        return self.rows

    def item(self):
        return self.rows

    def numel(self):
        return len(self.rows)

    def unsqueeze(self, _):
        return Tensor([self.rows])

    def __len__(self):
        return len(self.rows)

    def __iter__(self):
        return (Tensor(r) if isinstance(r, list) else r for r in self.rows)

    def __float__(self):
        return float(self.rows)

    def __getitem__(self, k):
        if isinstance(k, tuple):
            out = self
            for one in k:
                out = out[one]
            return out
        return Tensor(self.rows[k])

    @property
    def T(self):
        return Tensor([list(c) for c in zip(*self.rows)])

    def __matmul__(self, other):
        a, b = self.rows, other.rows
        if a and not isinstance(a[0], list):
            a = [a]; one = True
        else:
            one = False
        if b and not isinstance(b[0], list):
            out = [sum(x * y for x, y in zip(r, b)) for r in a]
            return Tensor(out[0] if one else out)
        cols = list(zip(*b))
        out = [[sum(x * y for x, y in zip(r, c)) for c in cols] for r in a]
        return Tensor(out[0] if one else out)
