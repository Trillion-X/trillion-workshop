import sys
from pathlib import Path
target=Path(sys.argv[1])
patch=Path(sys.argv[2])
target.write_text(target.read_text()+patch.read_text())
