import sys
from pathlib import Path
p=Path(sys.argv[1])
sys.stdout.write(p.read_text())
