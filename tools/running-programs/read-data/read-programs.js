// tools/running-programs/read-data/read-programs.js
//
// Every program running on this Mac: its process id, name and memory (physical footprint and resident bytes), its
// parent, its session, when it started and how much processor time it has used, read from the system's process
// information (libproc, sysctl) through the JavaScript ObjC bridge, so no privileged program (ps and top are setuid) is
// started. Run by running-programs.mjs as `osascript -l JavaScript read-programs.js [commands <most bytes>]`; it prints
// one JSON line. A program whose memory or details this person may not read (another user's) is listed with null there.
// Asked for `commands`, each program also carries its command line (its arguments only, never its environment), read
// from at most <most bytes> of the kernel's argument area; a command it may not read is null.
ObjC.import('Foundation');
ObjC.bindFunction('proc_listallpids', ['int', ['void *', 'int']]);
ObjC.bindFunction('proc_name', ['int', ['int', 'void *', 'unsigned int']]);
ObjC.bindFunction('proc_pid_rusage', ['int', ['int', 'int', 'void *']]);
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
ObjC.bindFunction('getsid', ['int', ['int']]);
ObjC.bindFunction('mach_timebase_info', ['int', ['void *']]);
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'unsigned long']]);

const MOST = 16384;
const RUSAGE_INFO_V2 = 2;
// rusage_info_v2: a 16-byte uuid, then 8-byte counters; user time is the 1st, system time the 2nd (both in the
// machine's tick units, made milliseconds by mach_timebase_info), resident_size the 7th, phys_footprint the 8th.
const USER_TIME_AT = 16;
const SYSTEM_TIME_AT = 16 + 8;
const RESIDENT_AT = 16 + 6 * 8;
const FOOTPRINT_AT = 16 + 7 * 8;
// proc_bsdinfo (sys/proc_info.h, PROC_PIDTBSDINFO = 3): pbi_ppid at 16, pbi_start_tvsec at 120, pbi_start_tvusec at 128.
const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136;
const PARENT_AT = 16;
const START_SECONDS_AT = 120;
const START_MICROSECONDS_AT = 128;
// sysctl { CTL_KERN, KERN_PROCARGS2, pid }: argc (4 bytes), the program's path, padding nulls, then argc arguments
// each ending in a null, then the environment, which is never read here. The kernel refuses a buffer smaller than the
// whole area, so the buffer is the largest area there can be (kern.argmax) and only its first <most bytes> are read.
const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// The bytes at `offset`: the bridge hands raw memory over only as base64 text, and this JavaScript has no atob.
function bytesOf(data, offset, length) {
  const text = data.subdataWithRange($.NSMakeRange(offset, length)).base64EncodedStringWithOptions(0).js.replace(/=+$/, '');
  const bytes = [];
  let bits = 0, held = 0;
  for (const letter of text) {
    held = (held << 6) | ALPHABET.indexOf(letter);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((held >> bits) & 0xff); }
  }
  return bytes;
}
const unsigned = bytes => bytes.reduceRight((sum, byte) => sum * 256 + byte, 0);
// Memory holding `bytes`, made the same way back: base64 text the bridge turns into data.
function dataOf(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3);
    const n = (a << 16) | (b << 8) | c;
    text += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '=');
  }
  return $.NSMutableData.alloc.initWithData($.NSData.alloc.initWithBase64EncodedStringOptions(text, 0));
}
const littleEndian = (value, size) => Array.from({ length: size }, (_, i) => Math.floor(value / 2 ** (8 * i)) % 256);
const textOf = (data, offset, length) => $.NSString.alloc.initWithDataEncoding(data.subdataWithRange($.NSMakeRange(offset, length)), $.NSUTF8StringEncoding).js;

// The largest argument area a program can have, or 0 when the kernel does not say.
function largestArea() {
  const value = $.NSMutableData.dataWithLength(4);
  const size = dataOf(littleEndian(4, 8));
  const asked = dataOf([...littleEndian(CTL_KERN, 4), ...littleEndian(KERN_ARGMAX, 4)]);
  return $.sysctl(asked.mutableBytes, 2, value.mutableBytes, size.mutableBytes, null, 0) === 0 ? unsigned(bytesOf(value, 0, 4)) : 0;
}

// The command line of `pid` from at most `most` bytes of its argument area (held in `area`): its arguments joined by
// spaces, or null.
function commandOf(pid, most, area) {
  const size = dataOf(littleEndian(area.length, 8));
  const asked = dataOf([...littleEndian(CTL_KERN, 4), ...littleEndian(KERN_PROCARGS2, 4), ...littleEndian(pid, 4)]);
  if ($.sysctl(asked.mutableBytes, 3, area.mutableBytes, size.mutableBytes, null, 0) !== 0) return null;
  const length = Math.min(unsigned(bytesOf(size, 0, 8)), most);
  if (length < 4) return null;
  const bytes = bytesOf(area, 0, length);
  const count = unsigned(bytes.slice(0, 4));
  let at = 4;
  while (at < length && bytes[at] !== 0) at += 1;
  while (at < length && bytes[at] === 0) at += 1;
  const words = [];
  while (words.length < count && at < length) {
    let end = at;
    while (end < length && bytes[end] !== 0) end += 1;
    words.push(textOf(area, at, end - at));
    at = end + 1;
  }
  return words.length ? words.join(' ') : null;
}

function run(argv) {
  const commandBytes = argv[0] === 'commands' ? Number(argv[1]) : 0;
  const pids = $.NSMutableData.dataWithLength(MOST * 4);
  const found = $.proc_listallpids(pids.mutableBytes, MOST * 4);
  const name = $.NSMutableData.dataWithLength(256);
  const usage = $.NSMutableData.dataWithLength(512);
  const info = $.NSMutableData.dataWithLength(BSDINFO_SIZE);
  const timebase = $.NSMutableData.dataWithLength(8);
  $.mach_timebase_info(timebase.mutableBytes);
  const ticksToMs = unsigned(bytesOf(timebase, 0, 4)) / unsigned(bytesOf(timebase, 4, 4)) / 1e6;
  const area = commandBytes > 0 ? $.NSMutableData.dataWithLength(largestArea()) : null;
  const programs = [];
  for (let i = 0; i < Math.max(found, 0); i += 1) {
    const pid = unsigned(bytesOf(pids, i * 4, 4));
    if (pid <= 0) continue;
    const length = $.proc_name(pid, name.mutableBytes, 256);
    const named = length > 0 ? textOf(name, 0, length) : null;
    const read = $.proc_pid_rusage(pid, RUSAGE_INFO_V2, usage.mutableBytes) === 0;
    const known = $.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info.mutableBytes, BSDINFO_SIZE) === BSDINFO_SIZE;
    const session = $.getsid(pid);
    const program = { pid, name: named, footprint_bytes: read ? unsigned(bytesOf(usage, FOOTPRINT_AT, 8)) : null,
      resident_bytes: read ? unsigned(bytesOf(usage, RESIDENT_AT, 8)) : null,
      parent_pid: known ? unsigned(bytesOf(info, PARENT_AT, 4)) : null,
      session_id: session > 0 ? session : null,
      started_at_ms: known ? unsigned(bytesOf(info, START_SECONDS_AT, 8)) * 1000 + Math.floor(unsigned(bytesOf(info, START_MICROSECONDS_AT, 8)) / 1000) : null,
      cpu_ms: read ? Math.round((unsigned(bytesOf(usage, USER_TIME_AT, 8)) + unsigned(bytesOf(usage, SYSTEM_TIME_AT, 8))) * ticksToMs) : null };
    if (area) program.command = area.length ? commandOf(pid, commandBytes, area) : null;
    programs.push(program);
  }
  return JSON.stringify({ listed: found >= 0, programs });
}
