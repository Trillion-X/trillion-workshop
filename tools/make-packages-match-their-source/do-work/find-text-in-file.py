import sys
from pathlib import Path
s=Path(sys.argv[1]).read_text()
n=sys.argv[2]
i=s.find(n)
print(i)
print(s[max(0,i-1000):i+len(n)+2000])
