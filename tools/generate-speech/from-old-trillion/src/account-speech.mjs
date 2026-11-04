// src/account-speech.mjs
//
// PURPOSE
//   tool:speak (records/workshop-account-tool-records.json), run inside the person's own store on
//   placement:this-account: words said out loud in a natural voice, the person's own cloned voice or a neutral one,
//   made once by whichever of their devices can run a speech model (src/placement.json job speak, the device tool
//   there such as tool:say-with-a-voice-model, computer/speak.mjs) and kept in their Trillion files, so every device of
//   theirs plays the same sound: the Mac, the web app, a phone. The person store's account action map hands its own
//   store in (`speakAccount(this, input)`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Trillion pays for no speech: the job's places (src/placement.json) are only the person's own devices. With
//      none awake that can, the answer retains the words with `file: null` and `retryable: true`. No system voice
//      substitutes for the chosen natural voice; the caller keeps the request until a capable device is available.
//   2. Which device, which tool there and which voice are DATA (placement.json, the device's computer/speak.json and
//      the person's own list rows, src/voices.mjs); nothing here names one.
//   3. The answer is the kept sound ({ file, name, seconds, voice, engine, produced_by, speed }), the same for every
//      caller, so an AI, a rule, a workflow and a device all get one file to play. The sound is kept at its natural
//      pace; `speed` is the place's speed from the person's rows (src/voices.mjs), which whoever plays it applies with
//      the pitch kept, so the same sound plays at any speed set later.
//   4. Which voice and speed is read from the person's list rows for the place asked (`place`, a row of the list of
//      places Trillion speaks); a `voice` asked by id wins over the place's.

import { runToEnd } from '../../../audio-transcription/src/account-transcription.mjs';

const NO_DEVICE = 'None of your devices that can make a natural voice is awake. No sound was made; keep these words and retry when a capable device is available.';

/**
 * Says `text` on a device of theirs and keeps the sound, in `voice` (a voice id of the person's) or else the voice of
 * `place` (a place Trillion speaks), at that place's speed.
 */
export async function speakAccount(store, { text, voice, place } = {}, options) {
  const words = String(text ?? '').trim();
  if (!words) throw new Error('Give the words to say.');
  const how = store.voices().answer({ place: place ?? null, voice: voice ?? null });
  const chosen = voice ?? how.voice?.id ?? null;
  const at = await store.placeWork('speak');
  if (!at.device) return { file: null, system_voice: false, retryable: true, text: words, speed: how.speed, said: NO_DEVICE };
  const run = await runToEnd(store.workshop(), { tool_id: at.device.tool_id, input: { text: words, ...(chosen ? { voice: chosen } : {}) }, request_key: `speak:${Date.now()}:${words.slice(0, 40)}` }, options);
  if (run.state !== 'completed' || typeof run.output?.file !== 'string' || !run.output.file.trim()) {
    return { file: null, system_voice: false, retryable: true, text: words, speed: how.speed, said: run.state !== 'completed' ? 'Your device could not make the voice. No sound was made; keep these words and retry on a capable device.' : 'Your device did not return a natural-voice sound. Keep these words and retry on a capable device.' };
  }
  return { ...run.output, speed: how.speed, made_on: at.device.placement, system_voice: false };
}
