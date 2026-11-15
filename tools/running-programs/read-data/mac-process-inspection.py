#!/usr/bin/env python3
"""Small, fail-closed macOS process identity probe for sandboxed callers."""

import ctypes
import datetime
import json
import locale
import os
import re
import subprocess
import sys
import errno


MAXCOMLEN = 16
PROC_PIDTBSDINFO = 3
PROC_INFO_SIZE = 256
MAX_KERNEL_SNAPSHOT = 16 * 1024 * 1024
KERN_PROC_ALL = 0
KERN_PROC_PID = 1


class Timeval(ctypes.Structure):
    _fields_ = [('sec', ctypes.c_long), ('usec', ctypes.c_int)]


class ProcPrefix(ctypes.Structure):
    _fields_ = [
        ('birth', Timeval), ('vmspace', ctypes.c_void_p), ('sigacts', ctypes.c_void_p),
        ('flags', ctypes.c_int), ('status', ctypes.c_char), ('pid', ctypes.c_int),
    ]


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * MAXCOMLEN),
        ("pbi_name", ctypes.c_char * (2 * MAXCOMLEN)),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


class KernelGroupPrefix(ctypes.Structure):
    # Darwin's public 64-bit kinfo_proc ABI (sys/sysctl.h), through e_pgid.
    # Clang's SDK layout: kp_eproc at 296, e_ppid at 560, e_pgid at 564; total 648.
    _fields_ = [
        ("process", ProcPrefix), ("before_parent", ctypes.c_byte * 512),
        ("parent_pid", ctypes.c_int), ("group_id", ctypes.c_int),
    ]


def kernel_process_groups(raw, stride):
    """Birth-qualified PGIDs from the captured table, without chasing exited PIDs.

    The public ABI is admitted only after its stride, prefix and own live group
    agree with libproc and getpgid. Unsupported layouts remain unverified. This
    is observation only; it supplies no absence, signal or cleanup authority.
    """
    if (sys.platform != "darwin" or ctypes.sizeof(ctypes.c_void_p) != 8 or stride != 648
            or ctypes.sizeof(ProcPrefix) != 48 or KernelGroupPrefix.group_id.offset != 564):
        raise RuntimeError("kernel process group layout is unverified")
    own_pid = os.getpid()
    current = kernel_process_bytes(KERN_PROC_PID, own_pid)
    if len(current) != stride:
        raise RuntimeError("kernel process group layout is incomplete")
    own = KernelGroupPrefix.from_buffer_copy(current)
    info = process_info(own_pid)
    if (int(own.process.pid) != own_pid or int(info.pbi_pid) != own_pid
            or [int(own.process.birth.sec), int(own.process.birth.usec)]
                != [int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)]
            or int(own.group_id) <= 0 or int(own.group_id) != os.getpgid(own_pid)
            or int(own.group_id) != int(info.pbi_pgid)):
        raise RuntimeError("kernel process group layout changed or is unavailable")
    if not raw or len(raw) > MAX_KERNEL_SNAPSHOT or len(raw) % stride:
        raise RuntimeError("kernel process group snapshot is incomplete")
    groups, seen = {}, set()
    for offset in range(0, len(raw), stride):
        row = KernelGroupPrefix.from_buffer_copy(raw, offset)
        pid = int(row.process.pid)
        if pid == 0:
            continue
        birth = (int(row.process.birth.sec), int(row.process.birth.usec))
        group_id = int(row.group_id)
        if pid < 0 or pid in seen or birth[0] <= 0 or not 0 <= birth[1] < 1000000 or group_id < 0:
            raise RuntimeError("kernel process group snapshot is malformed")
        seen.add(pid)
        groups[(pid, birth)] = group_id
    return groups


def fail(message):
    print(message, file=sys.stderr)
    return 2


def positive_pid(value):
    try:
        pid = int(value, 10)
    except (TypeError, ValueError):
        raise ValueError("PID must be a positive integer")
    if pid <= 0:
        raise ValueError("PID must be a positive integer")
    return pid


def process_info(pid):
    if sys.platform != "darwin":
        raise RuntimeError("macOS process inspection is unavailable")
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    proc_pidinfo = library.proc_pidinfo
    proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    proc_pidinfo.restype = ctypes.c_int
    info = ProcBsdInfo()
    copied = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
    if copied != ctypes.sizeof(info) or info.pbi_pid != pid:
        raise RuntimeError("kernel process metadata unavailable")
    return info


def process_birth(pid):
    info = process_info(pid)
    birth = [int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)]
    if birth[0] <= 0 or not 0 <= birth[1] < 1_000_000:
        raise RuntimeError("kernel process birth unavailable")
    return birth


def kernel_process_bytes(kind, pid=0):
    if sys.platform != "darwin":
        raise RuntimeError("macOS process inspection is unavailable")
    library = ctypes.CDLL(None, use_errno=True)
    sysctl = library.sysctl
    sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                       ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    sysctl.restype = ctypes.c_int
    mib = (ctypes.c_int * 4)(1, 14, kind, pid)
    size = ctypes.c_size_t()
    if sysctl(mib, 4, None, ctypes.byref(size), None, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if size.value <= 0 or size.value > MAX_KERNEL_SNAPSHOT:
        raise RuntimeError("kernel process snapshot size is outside its bound")
    # KERN_PROC_ALL can grow between the size and data calls. Reserve the
    # existing admitted bound so unrelated forks do not repeatedly exhaust an
    # exact-size buffer. Oversize, partial and unavailable tables still refuse.
    capacity = MAX_KERNEL_SNAPSHOT if kind == KERN_PROC_ALL else size.value
    buffer = ctypes.create_string_buffer(capacity)
    actual = ctypes.c_size_t(capacity)
    if sysctl(mib, 4, buffer, ctypes.byref(actual), None, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if actual.value <= 0 or actual.value > capacity:
        raise RuntimeError("kernel process snapshot changed outside its bound")
    return ctypes.string_at(buffer, actual.value)


def kernel_stride():
    raw = kernel_process_bytes(KERN_PROC_PID, os.getpid())
    if len(raw) < ctypes.sizeof(ProcPrefix):
        raise RuntimeError("kernel process record is truncated")
    prefix = ProcPrefix.from_buffer_copy(raw)
    if ctypes.sizeof(ProcPrefix) != 48 or ProcPrefix.pid.offset != 40 or prefix.pid != os.getpid():
        raise RuntimeError("kernel process record prefix is unverified")
    if [int(prefix.birth.sec), int(prefix.birth.usec)] != process_birth(os.getpid()):
        raise RuntimeError("kernel process record birth is unverified")
    if not 0 <= prefix.birth.usec < 1_000_000:
        raise RuntimeError("kernel process record birth is malformed")
    stride = len(raw)
    if stride < ctypes.sizeof(ProcPrefix) or stride > MAX_KERNEL_SNAPSHOT:
        raise RuntimeError("kernel process record stride is outside its bound")
    return stride


def kernel_birth_rows():
    # Retry only bounded kernel size races. A malformed or persistently changing
    # table stays unknown; callers never infer absence from a partial snapshot.
    for attempt in range(3):
        try:
            stride = kernel_stride()
            raw = kernel_process_bytes(KERN_PROC_ALL)
            if len(raw) % stride:
                raise RuntimeError("kernel process snapshot has a partial record")
            rows = []
            for offset in range(0, len(raw), stride):
                prefix = ProcPrefix.from_buffer_copy(raw, offset)
                pid = int(prefix.pid)
                birth = [int(prefix.birth.sec), int(prefix.birth.usec)]
                if pid < 0 or birth[0] <= 0 or not 0 <= birth[1] < 1_000_000:
                    raise RuntimeError("kernel process snapshot contains malformed identity")
                if pid > 0:
                    rows.append({"pid": pid, "birth": birth})
            return rows
        except OSError as error:
            if error.errno not in (errno.ENOMEM, errno.EAGAIN) or attempt == 2:
                raise
        except RuntimeError:
            if attempt == 2:
                raise
    raise RuntimeError("kernel process snapshot remained unstable")


def valid_birth(value):
    return isinstance(value, list) and len(value) == 2 and all(type(part) is int for part in value) \
        and value[0] > 0 and 0 <= value[1] < 1_000_000


def session_baseline():
    return kernel_birth_rows()


def session_members(sid, anchor_birth, baseline):
    if not isinstance(sid, int) or isinstance(sid, bool) or sid <= 0:
        raise ValueError("session ID must be a positive integer")
    if anchor_birth is not None and not valid_birth(anchor_birth):
        raise ValueError("session anchor birth is malformed")
    if not isinstance(baseline, list):
        raise ValueError("session baseline must be a list")
    baseline_pairs = set()
    for row in baseline:
        if not isinstance(row, dict) or not isinstance(row.get("pid"), int) or isinstance(row.get("pid"), bool) \
                or row["pid"] <= 0 or not valid_birth(row.get("birth")):
            raise ValueError("session baseline contains malformed identity")
        baseline_pairs.add((row["pid"], tuple(row["birth"])))

    for attempt in range(3):
        try:
            stride = kernel_stride()
            raw = kernel_process_bytes(KERN_PROC_ALL)
            if len(raw) % stride:
                raise RuntimeError("kernel process snapshot has a partial record")
            snapshot = []
            for offset in range(0, len(raw), stride):
                prefix = ProcPrefix.from_buffer_copy(raw, offset)
                pid = int(prefix.pid)
                birth = [int(prefix.birth.sec), int(prefix.birth.usec)]
                if pid <= 0:
                    continue
                # Darwin sys/proc.h: SZOMB=5. Already-dead tasks cannot
                # execute or fork after this atomic snapshot. Their getsid
                # is ESRCH even while the kernel retains their PID record.
                # Keep the anchor mandatory; group absence is still proved
                # separately by ESRCH before ordinary lease release.
                if pid != sid and prefix.status == b"\x05":
                    continue
                if birth[0] <= 0 or not 0 <= birth[1] < 1_000_000:
                    raise RuntimeError("kernel process snapshot contains malformed birth")
                if (pid, tuple(birth)) in baseline_pairs:
                    continue
                snapshot.append((pid, birth))

            members = []
            anchor_seen = False
            uncertain = False
            helper_pid = os.getpid()
            for pid, birth in snapshot:
                try:
                    sid_now = os.getsid(pid)
                    # A process in another session cannot join this existing
                    # session: setsid creates its own SID, and setpgid cannot
                    # cross session boundaries. Its libproc metadata may be
                    # private without making this owned session uncertain.
                    if sid_now != sid:
                        continue
                    info = process_info(pid)
                    confirmed_birth = [int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)]
                    if int(info.pbi_pid) != pid or confirmed_birth != birth:
                        uncertain = True
                        continue
                    if pid == sid:
                        if sid_now != sid or (anchor_birth is not None and confirmed_birth != anchor_birth):
                            uncertain = True
                            continue
                        anchor_birth = confirmed_birth
                        anchor_seen = True
                    if sid_now != sid:
                        continue
                    if pid == helper_pid and helper_pid != sid:
                        continue
                    pgid = int(info.pbi_pgid)
                    if pgid <= 0:
                        uncertain = True
                        continue
                    members.append({"pid": pid, "birth": birth, "sid": sid, "pgid": pgid})
                except (OSError, ProcessLookupError, PermissionError, RuntimeError):
                    uncertain = True
            if uncertain:
                raise RuntimeError("kernel process membership changed during inspection")
            if not anchor_seen:
                raise RuntimeError("owned session anchor is absent or has a different incarnation")
            if anchor_birth is not None and not any(row["pid"] == sid and row["birth"] == anchor_birth for row in members):
                raise RuntimeError("owned session anchor could not be verified")
            return members
        except OSError as error:
            if error.errno not in (errno.ENOMEM, errno.EAGAIN) or attempt == 2:
                raise
        except RuntimeError:
            if attempt == 2:
                raise
    raise RuntimeError("owned session membership remained unknown")


def session_is_absent(sid, anchor_birth, baseline):
    """Prove twice that the original session has no live, post-baseline members.

    Unlike session_members, this read-only query permits the original anchor to
    have exited. The anchor's exact birth still names the session incarnation;
    PID reuse, incomplete inventory, or an unqualified probe race refuses it.
    """
    if not isinstance(sid, int) or isinstance(sid, bool) or sid <= 0:
        raise ValueError("session ID must be a positive integer")
    if not valid_birth(anchor_birth):
        raise ValueError("session anchor birth is required and must be valid")
    if not isinstance(baseline, list):
        raise ValueError("session baseline must be a list")

    anchor_time = tuple(anchor_birth)
    baseline_pairs = set()
    baseline_pids = set()
    for row in baseline:
        if not isinstance(row, dict) or not isinstance(row.get("pid"), int) or isinstance(row.get("pid"), bool) \
                or row["pid"] <= 0 or not valid_birth(row.get("birth")):
            raise ValueError("session baseline contains malformed identity")
        pid, birth = row["pid"], tuple(row["birth"])
        if pid in baseline_pids:
            raise ValueError("session baseline contains a duplicate PID")
        if pid == sid and birth == anchor_time:
            raise ValueError("session baseline cannot contain its original anchor")
        if birth >= anchor_time:
            raise ValueError("session baseline is not strictly older than its anchor")
        baseline_pids.add(pid)
        baseline_pairs.add((pid, birth))

    # setsid can only leave a session by creating SID == the caller's PID;
    # setpgid cannot join another session. An exact incarnation observed in a
    # foreign, non-self session therefore never belonged to this target. Keep
    # that one-way proof across the scans; foreign self-session leaders remain
    # ambiguous because they could have forked target members before leaving.
    foreign_sessions = {}
    never_owned = set()
    valid_statuses = (b"\x01", b"\x02", b"\x03", b"\x04", b"\x05", b"\x06", b"\x07")

    def refusal(message, stage, scan, pid=None, birth=None, cause=None, first=None, second=None):
        # Only source-owned labels and validated kernel identities enter this
        # separate diagnostic. Exception text, command and environment do not.
        details = {"schema": "mac-process-inspection-diagnostic/v1", "stage": stage, "scan": scan}
        if pid is not None:
            details.update(pid=pid, birth=list(birth))
        if cause is not None:
            classes = {ProcessLookupError: "ProcessLookupError", PermissionError: "PermissionError",
                       OSError: "OSError", RuntimeError: "RuntimeError"}
            kind = type(cause)
            number = cause.errno if kind in (ProcessLookupError, PermissionError, OSError) else None
            details["error_class"] = classes.get(kind, "Other")
            details["errno"] = number if type(number) is int and 0 <= number <= 2_147_483_647 else None
        if first is not None:
            left, right = first - second, second - first
            def rows(values):
                return [{"pid": pid, "birth": list(birth), "sid": sid}
                        for pid, birth, sid in sorted(values)[:8]]
            details.update(first_only_count=len(left), second_only_count=len(right),
                           first_only=rows(left), second_only=rows(right))
        error = RuntimeError(message)
        error.inspection_details = details
        return error

    def one_complete_absence_scan(scan):
        stride = kernel_stride()
        raw = kernel_process_bytes(KERN_PROC_ALL)
        if len(raw) % stride:
            raise RuntimeError("kernel process snapshot has a partial record")
        snapshot_pids = set()
        live_inventory = set()
        for offset in range(0, len(raw), stride):
            prefix = ProcPrefix.from_buffer_copy(raw, offset)
            pid = int(prefix.pid)
            birth = [int(prefix.birth.sec), int(prefix.birth.usec)]
            status = prefix.status
            if pid < 0 or birth[0] <= 0 or not 0 <= birth[1] < 1_000_000 \
                    or status not in valid_statuses:
                raise RuntimeError("kernel process snapshot contains a malformed row")
            if pid in snapshot_pids:
                raise RuntimeError("kernel process snapshot contains a duplicate PID")
            snapshot_pids.add(pid)
            if pid == 0:
                continue
            # The session ID is the original leader PID. Any other incarnation
            # at that number makes the target session identity ambiguous, even
            # if it appears in the prelaunch baseline or is already a zombie.
            if pid == sid and birth != anchor_birth:
                raise RuntimeError("session ID now has a different process incarnation")
            if status == b"\x05":  # Darwin SZOMB: cannot execute or fork.
                continue
            if (pid, tuple(birth)) in baseline_pairs:
                continue
            try:
                current_sid = os.getsid(pid)
            except (OSError, ProcessLookupError, PermissionError) as error:
                raise refusal("kernel process session changed during absence inspection",
                              "getsid", scan, pid, birth, error) from error
            if not isinstance(current_sid, int) or isinstance(current_sid, bool) or current_sid <= 0:
                raise RuntimeError("kernel process session probe returned a malformed SID")
            if pid == sid and current_sid != sid:
                raise RuntimeError("live original session anchor reported a different SID")
            if current_sid != sid:
                # getsid is a PID lookup, not an incarnation-bound read. Bind
                # its foreign observation to a completed public kernel row;
                # PID reuse, disappearance or partial data stays unknown.
                try:
                    completed = kernel_process_bytes(KERN_PROC_PID, pid)
                except (OSError, RuntimeError) as error:
                    raise refusal("foreign process incarnation is unavailable during absence inspection",
                                  "foreign-kernel-completion", scan, pid, birth, error) from error
                if len(completed) != stride:
                    raise RuntimeError("foreign process kernel row is incomplete during absence inspection")
                confirmed = ProcPrefix.from_buffer_copy(completed)
                confirmed_birth = [int(confirmed.birth.sec), int(confirmed.birth.usec)]
                if int(confirmed.pid) != pid or confirmed_birth != birth or confirmed.status not in valid_statuses:
                    raise RuntimeError("foreign process incarnation changed during absence inspection")
                identity = (pid, tuple(birth))
                previous_sid = foreign_sessions.get(identity)
                if previous_sid is not None and current_sid != previous_sid and current_sid != pid:
                    raise RuntimeError("foreign process session history is contradictory during absence inspection")
                foreign_sessions[identity] = current_sid
                if current_sid != pid:
                    never_owned.add(identity)
                if identity not in never_owned:
                    live_inventory.add((pid, tuple(birth), current_sid))
                continue
            try:
                info = process_info(pid)
            except (OSError, ProcessLookupError, PermissionError, RuntimeError) as error:
                raise refusal("kernel process identity is unavailable during absence inspection",
                              "member-info", scan, pid, birth, error) from error
            confirmed_birth = [int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)]
            if int(info.pbi_pid) != pid or confirmed_birth != birth:
                raise RuntimeError("kernel process identity changed during absence inspection")
            if pid == sid and confirmed_birth != anchor_birth:
                raise RuntimeError("session anchor incarnation changed during absence inspection")
            return False, live_inventory
        return True, live_inventory

    # A single empty snapshot cannot exclude a process created as the previous
    # inventory was being read. Both scans must be complete and independently
    # free of live members; any failed scan remains unknown, never absence.
    first_absent, first_inventory = one_complete_absence_scan(1)
    if not first_absent:
        return False
    second_absent, second_inventory = one_complete_absence_scan(2)
    if not second_absent:
        return False
    if first_inventory != second_inventory:
        raise refusal("ambiguous post-baseline session leaders changed between absence scans",
                      "inventory-change", 2, first=first_inventory, second=second_inventory)
    return True


def session_member_matches(pid, birth, sid):
    pid = positive_pid(str(pid))
    if not valid_birth(birth) or not isinstance(sid, int) or isinstance(sid, bool) or sid <= 0:
        raise ValueError("session member identity is malformed")
    try:
        current_sid = os.getsid(pid)
    except ProcessLookupError:
        return False
    info = process_info(pid)
    current_birth = [int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)]
    if int(info.pbi_pid) != pid or current_birth != birth:
        return False
    return current_sid == sid


def process_started(info):
    # Match ps lstart's C-locale spelling and local-time interpretation.
    locale.setlocale(locale.LC_TIME, "C")
    started = datetime.datetime.fromtimestamp(info.pbi_start_tvsec).astimezone()
    return started.strftime("%a %b %e %H:%M:%S %Y")


def executable_path(pid):
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    proc_pidpath = library.proc_pidpath
    proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    proc_pidpath.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(4096)
    length = proc_pidpath(pid, buffer, ctypes.sizeof(buffer))
    if length <= 0 or length >= ctypes.sizeof(buffer):
        raise RuntimeError("kernel executable path unavailable")
    path = os.fsdecode(buffer.value)
    if not path.startswith("/"):
        raise RuntimeError("kernel executable path is not absolute")
    return path


def is_browser_path(path):
    return re.search(r"Google Chrome|Chromium|chrome-for-testing|chromium_headless_shell|chrome-headless-shell|headless_shell", path, re.IGNORECASE) is not None


def has_headless_flag(command):
    return re.search(r"(?:^|\s)--headless(?:=\S*)?(?=\s|$)", command) is not None


def is_root_browser_command(command):
    return re.search(r"(?:^|\s)--type(?:=|\s)", command) is None


def headless_rows(pattern):
    if not pattern:
        raise ValueError("browser-name regex is required")
    result = subprocess.run(
        ["/usr/bin/pgrep", "-ifl", pattern],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
        timeout=1.5,
    )
    if result.returncode == 1:
        return []
    if result.returncode != 0:
        raise RuntimeError("pgrep failed")

    candidates = []
    for line in result.stdout.splitlines():
        pid_text, separator, command = line.partition(" ")
        if not separator or not pid_text.isdecimal():
            raise RuntimeError("pgrep returned an unreadable process row")
        pid = positive_pid(pid_text)
        if not has_headless_flag(command) or not is_root_browser_command(command):
            continue
        path = executable_path(pid)
        if not is_browser_path(path):
            continue
        info = process_info(pid)
        candidates.append({
            "pid": pid,
            "ppid": int(info.pbi_ppid),
            "process_started": process_started(info),
            "command": command[:180],
        })

    candidate_pids = {row["pid"] for row in candidates}
    return [row for row in candidates if row["ppid"] not in candidate_pids]


def main(argv):
    diagnostic = False
    try:
        if len(argv) == 2 and argv[0] == "start":
            info = process_info(positive_pid(argv[1]))
            print(json.dumps(process_started(info)))
            return 0
        if len(argv) == 2 and argv[0] == "birth":
            print(json.dumps(process_birth(positive_pid(argv[1])), separators=(",", ":")))
            return 0
        if len(argv) == 1 and argv[0] == "session-baseline":
            print(json.dumps(session_baseline(), separators=(",", ":")))
            return 0
        if len(argv) == 1 and argv[0] == "session-members":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise ValueError("session-members input must be an object")
            rows = session_members(request.get("sid"), request.get("anchor_birth"), request.get("baseline"))
            print(json.dumps(rows, separators=(",", ":")))
            return 0
        if len(argv) in (1, 2) and argv[0] == "session-absent" \
                and (len(argv) == 1 or argv[1] == "--diagnostic"):
            diagnostic = len(argv) == 2
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise ValueError("session-absent input must be an object")
            print(json.dumps(session_is_absent(request.get("sid"), request.get("anchor_birth"), request.get("baseline"))))
            return 0
        if len(argv) == 1 and argv[0] == "member":
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise ValueError("member input must be an object")
            print(json.dumps(session_member_matches(request.get("pid"), request.get("birth"), request.get("sid"))))
            return 0
        if len(argv) == 2 and argv[0] == "relation":
            info = process_info(positive_pid(argv[1]))
            parent, group = int(info.pbi_ppid), int(info.pbi_pgid)
            if parent < 0 or group <= 0:
                raise RuntimeError("kernel process relation unavailable")
            print(json.dumps({"parent": parent, "group": group}, separators=(",", ":")))
            return 0
        if len(argv) == 2 and argv[0] == "headless":
            print(json.dumps(headless_rows(argv[1]), separators=(",", ":")))
            return 0
        return fail("usage: mac-process-inspection.py start PID | birth PID | session-baseline | session-members | session-absent | member | relation PID | headless BROWSER_NAME_REGEX")
    except (OSError, ValueError, OverflowError, RuntimeError, subprocess.SubprocessError) as error:
        status = fail(str(error))
        if diagnostic and type(error) is RuntimeError and hasattr(error, "inspection_details"):
            print("mac-process-inspection-diagnostic: " + json.dumps(
                error.inspection_details, separators=(",", ":")), file=sys.stderr)
        return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
