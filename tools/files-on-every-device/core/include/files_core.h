/* include/files_core.h
 *
 * The files core's C ABI: the one door every shell (Swift File Provider, Windows cfapi, Android JNI, Linux FUSE3)
 * uses. Written by hand from src/ffi.rs; tests/abi.rs holds the two to the same functions and drives the core
 * through them.
 *
 * Use
 *   1. files_core_new(setup JSON) once: {origin}, where this computer's engine door is (the origin is the shell's
 *      own word for it, a local socket included; the core only joins core/contract.json `call.path` to it). The
 *      first command is `ready {root, name, trash}`: the one place the shell shows (the whole of the person's files)
 *      and its OS's trash container. Before its first job the core asks the door itself for the contract's `bounds`
 *      and for this computer's id and name.
 *   2. Hand every OS callback, network answer and passing of time to files_core_event as one JSON event
 *      (src/protocol.rs EventKind) with the bytes it carries (an answer's body, a local file's piece) beside it.
 *   3. After each event, take commands with files_core_next_command until it answers 0, and carry each out; a
 *      command whose JSON says "bytes": n has n bytes, taken with files_core_take_bytes right after it.
 *
 * Rules
 *   - Every pointer is null or valid for the length beside it; a core is used by one thread at a time.
 *   - files_core_next_command copies nothing when the buffer is too small and answers the length needed; the same
 *     command waits for the next call.
 *   - The core reads no clock, file or socket. Every event carries "now_ms", the host's monotonic milliseconds; a
 *     `wake {at_ms}` command says when to send a `tick` if nothing else happens first.
 *   - Every `send` is one JSON-RPC message to the engine's door: POST, with the command's `content_type` and `accept`
 *     as its headers and its bytes as the body. Its `answer` event says `reached` (false when no body came), carries
 *     the answer's headers by lowercase name (`headers`: a raw span is told apart and checked by them) and the body as
 *     it came, whatever its transport status: the core reads every refusal from the body.
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
