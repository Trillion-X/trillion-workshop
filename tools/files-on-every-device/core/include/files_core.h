/* include/files_core.h
 *
 * The files core's C ABI: the one door every shell (Swift File Provider, Windows cfapi, Android JNI, Linux FUSE3)
 * uses. Written by hand from src/ffi.rs; tests/abi.rs holds the two to the same functions and drives the core
 * through them.
 *
 * Use
 *   1. files_core_new(setup JSON) once: {device, device_label, computers: [{origin}], bounds: {span_most_bytes,
 *      piece_most_bytes, idle_ms}}, the bounds read from the contract's own settings (core/contract.json `bounds`).
 *   2. Hand every OS callback, network answer and passing of time to files_core_event as one JSON event
 *      (src/protocol.rs EventKind) with the bytes it carries (an answer's body, a local file's piece) beside it.
 *   3. After each event, take commands with files_core_next_command until it answers 0, and carry each out; a
 *      command whose JSON says "bytes": n has n bytes, taken with files_core_take_bytes right after it.
 *
 * Rules
 *   - Every pointer is null or valid for the length beside it; a core is used by one thread at a time.
 *   - files_core_next_command copies nothing when the buffer is too small and answers the length needed; the same
 *     command waits for the next call.
 *   - The core reads no clock, file or socket. Every event carries "now_ms", the host's monotonic milliseconds.
 */
#ifndef FILES_CORE_H
#define FILES_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct FilesCore FilesCore;

/* A core from its setup JSON; NULL when the setup is refused. */
FilesCore *files_core_new(const uint8_t *setup, size_t setup_length);

/* Free a core made by files_core_new. */
void files_core_free(FilesCore *core);

/* One event JSON and the bytes it carries (NULL, 0 for none). 0 when taken; else the length of the refusal text. */
size_t files_core_event(FilesCore *core, const uint8_t *event, size_t event_length, const uint8_t *bytes,
                        size_t bytes_length);

/* The next command JSON into out. Its length; 0 when none waits; above capacity: nothing copied, call again. */
size_t files_core_next_command(FilesCore *core, uint8_t *out, size_t capacity);

/* The bytes of the last command taken into out; their length (nothing copied when capacity is too small). */
size_t files_core_take_bytes(FilesCore *core, uint8_t *out, size_t capacity);

/* The text of the last refused event into out; its length. */
size_t files_core_refusal(FilesCore *core, uint8_t *out, size_t capacity);

#ifdef __cplusplus
}
#endif

#endif
