"""Read the known pause and word regions of the synthetic cleaned-take fixture."""
import json
import sys

import numpy as np
import soundfile as sf

samples, rate = sf.read(sys.argv[1])
print(json.dumps({
    "pause": float(np.abs(samples[int(1.6 * rate):int(2.3 * rate)]).max()),
    "word": float(np.abs(samples[int(2.5 * rate):int(2.8 * rate)]).max()),
}))
