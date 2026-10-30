// tools/running-programs/read-data/read-programs.js
//
// Every program running on this Mac: its process id, name and memory (physical footprint and resident bytes), read
// from the system's process information (libproc) through the JavaScript ObjC bridge, so no privileged program
// (ps and top are setuid) is started. Run by running-programs.mjs as `osascript -l JavaScript read-programs.js`; it
// prints one JSON line. A program whose memory this person may not read (another user's) is listed with null memory.
ObjC.import('Foundation');
ObjC.bindFunction('proc_listallpids', ['int', ['void *', 'int']]);
ObjC.bindFunction('proc_name', ['int', ['int', 'void *', 'unsigned int']]);
ObjC.bindFunction('proc_pid_rusage', ['int', ['int', 'int', 'void *']]);

const MOST = 16384;
const RUSAGE_INFO_V2 = 2;
// rusage_info_v2: a 16-byte uuid, then 8-byte counters; resident_size is the 7th, phys_footprint the 8th.
const RESIDENT_AT = 16 + 6 * 8;
const FOOTPRINT_AT = 16 + 7 * 8;

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

function run() {
  const pids = $.NSMutableData.dataWithLength(MOST * 4);
  const found = $.proc_listallpids(pids.mutableBytes, MOST * 4);
  const name = $.NSMutableData.dataWithLength(256);
  const usage = $.NSMutableData.dataWithLength(512);
  const programs = [];
  for (let i = 0; i < Math.max(found, 0); i += 1) {
    const pid = unsigned(bytesOf(pids, i * 4, 4));
    if (pid <= 0) continue;
    const length = $.proc_name(pid, name.mutableBytes, 256);
    const named = length > 0 ? $.NSString.alloc.initWithDataEncoding(name.subdataWithRange($.NSMakeRange(0, length)), $.NSUTF8StringEncoding).js : null;
    const read = $.proc_pid_rusage(pid, RUSAGE_INFO_V2, usage.mutableBytes) === 0;
    programs.push({ pid, name: named, footprint_bytes: read ? unsigned(bytesOf(usage, FOOTPRINT_AT, 8)) : null,
      resident_bytes: read ? unsigned(bytesOf(usage, RESIDENT_AT, 8)) : null });
  }
  return JSON.stringify({ listed: found >= 0, programs });
}
