# tools/know-who-is-in-this/

Tells who is in a recording or a picture, from voices and faces the person enrolled with consent: enrol a voice or face, name who said each stretch of a transcript, and find and name the faces in a picture or video. It measures with the models `tools/media-composition` already holds and keeps no second copy of them. Nothing is named unless the person enrolled and agreed.

## Files

| File | Purpose |
|------|---------|
| `read-data/who_is_in.py` | Pure, standard library only: the consent check, the print record, who a voice or face is (named only when one enrolled person is clearly the closest, else every person it could be, else nobody), naming the voices of a recording with unknown voices that keep their number through a listening, joining stretches into turns, naming faces. |
| `do-work/measure.py` | Loads media-composition's `find-recurring-voices.py` (CAM++ voice vectors, speech windows) and `blur-faces-not-agreed.py` (YuNet, SFace) and calls them. |
| `do-work/enrol-a-print.py` | `tool:enrol-a-voice-or-face`. Refuses without consent words or a known kind before it measures anything. |
| `do-work/who-is-in-this.py` | `tool:who-is-in-this`. A transcript's timed stretches in, who said each turn out, plus the listening's listening-voices record. |
| `do-work/find-faces.py` | `tool:find-faces`. Faces of a picture or video with their place and who they are. Changes no file. |
| `read-data/people.mjs` | `tool:people-listening-can-name`: each person the voice-print and face-print records can name, once, with sample counts and consent words, never the numbers (run as a function by `tools/records-door`). Moved from the product repo's `computer/know-who.py` `people`. |
| `tool-rows.json` | The four rows: three `container` rows, and `tool:people-listening-can-name`, a `computer` row with no capability that lists the two print kinds where they are kept. |
| `read-data/appearances.json` | DATA: the list `appearances` (Where people appeared: its fields, title and two views), the statuses, the words of a row's title and the print kinds a named person is checked against. Nothing in it names a person. |
| `read-data/appearances.mjs` | Pure: the answers of `tool:who-is-in-this` (`heard`) and `tool:find-faces` (`seen`) as list rows. A named turn or face joins its person's id, the seconds, the words said and the place; an unsure stretch keeps the people it could be, an unknown voice its number; a face nobody enrolled is not kept; sightings of one person no further apart than one and a half spacings are one stretch. |
| `do-work/keep-who-appeared.mjs` | `tool:keep-who-appeared`. Makes the list when it is missing, checks every named person's print still exists with consent words (else refuses, writes nothing), writes the rows in batches that fit the door, and marks rows of that recording and kind that the answer no longer holds `superseded`, deleting none. |
| `do-work/where-someone-appeared.mjs` | `tool:where-someone-appeared`. A read: the rows of a person, a recording or the words asked of the person's own search, in recording order, with who and which recordings they name. |
| `../workflows/recipes/keep-who-appeared-in-a-recording.json` | `workflow:keep-who-appeared-in-a-recording`: hear, see, keep, read back, one tool per step. |
| `test/test_who_is_in.py` | The pure readers on made-up voices and faces (each "person" is one axis of the vector space plus noise). |
| `test/appearances.test.mjs` | The rows on made-up people: a named stretch linked to person, recording, seconds and place; unsure and unknown voices keeping their label; the same answer twice is the same rows; a changed answer supersedes and deletes none; a print taken out refuses the keep; 400 rows in batches; the rows read back by person, recording and words. |
| `test/people.test.mjs` | The people list on a fake door: one row per person across kinds, no numbers. |
| `test/know-who-is-in-this.test.mjs` | Runs them, checks the consent refusal and that every row naming a print kind says `stays_on_this_device: true`. |
| `part.json` | Nothing here is imported by other code. |

## How it works

- A print is one record per person and kind (`voice-print`, `face-print`): the name, `me`, the sample vectors and the consent words with the day they were said. Enrolling the same name again adds samples and consent words; nothing is replaced.
- Prints and the `listening-voices` record (the unknown voices heard in one listening, with their numbers) are kinds that are `stays_on_this_device: true`. They are never shared, exported, synced or sent to a model off the device. Tool descriptions say so; the engine enforces it once the kind flag is wired (see Not yet).
- Unknown voices are `voice-1`, `voice-2` and so on, the same for the same voice across every recording of one `listening`. Two unknown voices that grow alike become one and list both labels, so what was kept under either label can be named together later.
- A voice heard in a listening can be enrolled (`heard_voice`): every label it was heard under is returned in `heard_as`, so the caller names what was already kept under each.
- Stretches of one voice in a recording are judged together, a stretch too short to measure takes its neighbour's voice, and turns of one voice a couple of seconds apart are joined.

## Where people appeared

`list:appearances` (row type `appearance`) is the web that links people to recordings. One row is one stretch of one recording: `subject` and `person` (the print's person id; `person_row` is that person's own row in their lists when the run was given it), `how` (voice heard or face seen), `recording`, `start` and `end` seconds, `words` said, `place` and `place_name` (where it was recorded, given, never guessed), `recorded_on`, and `status`: `named`, `possible` (with `could_be`), `unknown` (with `heard_as`, the voice's number in its listening) or `superseded`. A row holds no print numbers, so it is not a `stays_on_this_device` kind; the prints it relies on still are. Each row's title is a sentence with the name, the recording and the time, so the person's own search finds a person by name, by recording, by place or by a word they said. The row id is made from the recording, how it was known, its start and who it is: the same answer kept again is the same row, and a voice enrolled later names its stretches as new rows beside the superseded unknown ones.

`workflow:keep-who-appeared-in-a-recording` is how it is filled: `tool:who-is-in-this` and `tool:find-faces` (which change no file) answer, `tool:keep-who-appeared` keeps, `tool:where-someone-appeared` reads it back.

## Calibration

The thresholds are inputs (`rules`), with starting values in `read-data/who_is_in.py` (`VOICE_RULES`, `FACE_RULES`): a voice counts as a person from 0.72 cosine, a face from 0.363, the best must lead the next person by 0.05, and a possibility is listed from 0.55 (voices) or 0.25 (faces). They are written for CAM++ and SFace prints and have not been calibrated on anyone's own consented clips. Calibrate before relying on a name: enrol each person from a few consented clips, run `tool:who-is-in-this` on held-out clips of each of them and of strangers, and set the thresholds where wrong names stop. Tests here use made-up vectors only; no real person's voice or face is in this repository.

## Not yet

- Nothing recognises a place or an object in a picture or recording. A place is linked to a person's rows only when the run is given the place (`place`); no place row is guessed from a file.
- Taking a print out stops new rows from naming that person (the keep refuses) but does not mark the rows already kept; those are the person's to remove.
- The recipe has no wake: a new recording does not start it until a wake row is declared and switched on.
- Proof on a real recording needs the engine install that carries python, its wheels and the face models; the tests here use made-up answers and a fake door.
- The `stays_on_this_device` flag is words in the tool descriptions until the engine's record model carries it on the kind and every share, export and sync road refuses a record of that kind.
- Live microphone capture, the moments and turns of a running listening, and sending heard turns as records are a separate tool (a program started for the length of a listening).
- Naming a voice from the call app's own screen needs an Accessibility grant the engine does not yet have.
- The model files and Python modules are those of `tools/media-composition`'s container image; the tests that need them cannot run without that image.

## Dependencies

**Depends on:** `tools/records-door` (for `tool:people-listening-can-name`, `tool:keep-who-appeared` and `tool:where-someone-appeared`, which also pack `tools/browse-and-upload-my-files` as the door's file client needs), `tools/media-composition` (`do-work/find-recurring-voices.py`, `do-work/blur-faces-not-agreed.py`, the models and Python modules its image holds); Python 3.10 or later for the pure readers and tests, and Node for the test runner.

**Depended on by:** nothing is imported from here. `tool:who-is-in-this` is the tool the workflow recipes `find-moments-in-a-recording`, `hold-us-to-it` and `keep-who-appeared-in-a-recording` name for who was heard.
