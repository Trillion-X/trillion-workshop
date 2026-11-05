"""A stand-in for torch: only what the scripts name. torch.nn.Sigmoid is the cross-encoder's activation; from_numpy
gives a tensor whose matrix product and transpose are numpy's, and .numpy() gives the array back."""
import numpy as _np

from . import nn  # noqa: F401


class _Tensor:
    def __init__(self, array):
        self.array = _np.asarray(array)

    @property
    def T(self):
        return _Tensor(self.array.T)

    def __matmul__(self, other):
        return _Tensor(self.array @ other.array)

    def numpy(self):
        return self.array


def from_numpy(array):
    return _Tensor(array)
