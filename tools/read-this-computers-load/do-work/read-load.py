# Read-only sample of this computer's load: the 1-minute load average, the core count, the memory pressure's free percentage,
# and the names of the five processes using the most CPU. Prints one JSON line. Changes nothing on the computer.
import json, os, re, subprocess, datetime

def sh(*argv):
    return subprocess.run(list(argv), capture_output=True, text=True, timeout=20).stdout

loadavg = [float(x) for x in re.findall(r"[\d.]+", sh("sysctl", "-n", "vm.loadavg"))[:3]]
pressure = re.search(r"free percentage: (\d+)", sh("memory_pressure", "-Q"))
top = []
for line in sh("ps", "-axo", "%cpu=,comm=").splitlines()[:200]:
    cpu, _, comm = line.strip().partition(" ")
    top.append({"cpu_pct": float(cpu), "name": os.path.basename(comm.strip())})
top.sort(key=lambda p: p["cpu_pct"], reverse=True)

print(json.dumps({
    "read_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": sh("scutil", "--get", "ComputerName").strip(),
    "cores": int(sh("sysctl", "-n", "hw.ncpu").strip()),
    "load_1m": loadavg[0],
    "memory_pressure_free_pct": int(pressure.group(1)) if pressure else None,
    "top_cpu_names": [p["name"] for p in top[:5]],
}))
