# tools/know-who-is-in-this/

Tells who is in a recording or a picture, from voices and faces the person enrolled with consent: enrol a voice or face, name who said each stretch of a transcript, and find and name the faces in a picture or video. It measures with the models `tools/media-composition` already holds and keeps no second copy of them. Nothing is named unless the person enrolled and agreed.

## Files

| File | Purpose |
|------|---------|
| `read-data/who_is_in.py` | Pure, standard library only: the consent check, the print record, who a voice or face is (named only when one enrolled person is clearly the closest, else every person it could be, else nobody), naming the voices of a recording with unknown voices that keep their number through a listening, joining stretches into turns, naming faces. |
| `do-work/measure.py` | Loads media-composition's `find-recurring-voices.py` (CAM++ voice vectors, speech windows) and `blur-faces-not-agreed.py` (YuNet, SFace) and calls them. |
| `do-work/enrol-a-print.py` | `tool:enrol-a-voice-or-face`. Refuses without consent words or a known kind before it measures anything. |
| `do-work/who-is-in-this.py` | `tool:who-is-in-this`. A transcript's timed stretches in, who said each turn out, plus the listening's voice-session record. |
| `do-work/find-faces.py` | `tool:find-faces`. Faces of a picture or video with their place and who they are. Changes no file. |
| `tool-rows.json` | The three rows. |
| `test/test_who_is_in.py` | The pure readers on made-up voices and faces (each "person" is one axis of the vector space plus noise). |
| `test/know-who-is-in-this.test.mjs` | Runs them, checks the consent refusal and that every row naming a print kind says `stays_on_this_device: true`. |
| `part.json` | Nothing here is imported by other code. |

## How it works

- A print is one record per person and kind (`voice-print`, `face-print`): the name, `me`, the sample vectors and the consent words with the day they were said. Enrolling the same name again adds samples and consent words; nothing is replaced.
- Prints and the `voice-session` record (the unknown voices heard in one listening, with their numbers) are kinds that are `stays_on_this_device: true`. They are never shared, exported, synced or sent to a model off the device. Tool descriptions say so; the engine enforces it once the kind flag is wired (see Not yet).
- Unknown voices are `voice-1`, `voice-2` and so on, the same for the same voice across every recording of one `listening`. Two unknown voices that grow alike become one and list both labels, so what was kept under either label can be named together later.
- A voice heard in a listening can be enrolled (`heard_voice`): every label it was heard under is returned in `heard_as`, so the caller names what was already kept under each.
- Stretches of one voice in a recording are judged together, a stretch too short to measure takes its neighbour's voice, and turns of one voice a couple of seconds apart are joined.

## Calibration

The thresholds are inputs (`rules`), with starting values in `read-data/who_is_in.py` (`VOICE_RULES`, `FACE_RULES`): a voice counts as a person from 0.72 cosine, a face from 0.363, the best must lead the next person by 0.05, and a possibility is listed from 0.55 (voices) or 0.25 (faces). They are written for CAM++ and SFace prints and have not been calibrated on anyone's own consented clips. Calibrate before relying on a name: enrol each person from a few consented clips, run `tool:who-is-in-this` on held-out clips of each of them and of strangers, and set the thresholds where wrong names stop. Tests here use made-up vectors only; no real person's voice or face is in this repository.

## Not yet

- The `stays_on_this_device` flag is words in the tool descriptions until the engine's record model carries it on the kind and every share, export and sync road refuses a record of that kind.
- Live microphone capture, the moments and turns of a running listening, and sending heard turns as records are a separate tool (a program started for the length of a listening).
- Naming a voice from the call app's own screen needs an Accessibility grant the engine does not yet have.
- The model files and Python modules are those of `tools/media-composition`'s container image; the tests that need them cannot run without that image.

## Dependencies

**Depends on:** `tools/media-composition` (`do-work/find-recurring-voices.py`, `do-work/blur-faces-not-agreed.py`, the models and Python modules its image holds); Python 3.10 or later for the pure readers and tests, and Node for the test runner.

**Depended on by:** nothing is imported from here. `tool:who-is-in-this` is the tool the workflow recipes `find-moments-in-a-recording` and `hold-us-to-it` name for who was heard.
