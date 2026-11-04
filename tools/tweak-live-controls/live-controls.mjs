// tools/tweak-live-controls/live-controls.mjs
//
// A tool's live controls as one run: made-controls.mjs controlRows, unchanged, turns a tool descriptor (its input_schema
// and optional `controls` DATA) into the rows a person moves, and, when values are given, runInput checks each moved
// value against its row and the tool's own schema and answers the input the tool would run with.
//
//   liveControlsForATool({ descriptor, bind?, values? }) -> { controls, input? }
//     descriptor  { id?, label?, job?, input_schema: { properties, required? }, controls?, invoke? }
//     bind        the subject inputs (what is changed: a file, a row), set once and never drawn as a control
//     values      { <control key>: value } as a person moved them
//   controls is controlRows' answer: { tool_id, label, about, subject, settings, suggested, preview, commit, result,
//   input_schema, declared, runs }. input is runInput's answer (left out when no values or bind are given): the subject
//   bindings and every control not left at its neutral value.
//
// Refuses: a descriptor with no input_schema.properties object; a controls DATA subject or setting its schema does not
// hold; a value outside its row's range or not one of its choices (made-controls' own words name the control and why).
//
// What the run never does: it runs no tool, saves no interface, keeps no place, draws no preview and keeps no undo
// history (those are the app's screen and the account's records). It reads only what it is given and writes nothing.
import { controlRows, runInput } from './made-controls.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function liveControlsForATool({ descriptor, bind, values } = {}) {
  if (!object(descriptor) || !object(descriptor.input_schema?.properties)) {
    throw new Error('Give descriptor: the tool\'s descriptor, with input_schema.properties naming its inputs (and controls DATA if it has any).');
  }
  if (bind !== undefined && !object(bind)) throw new Error('bind is an object: { <subject input>: value }.');
  if (values !== undefined && !object(values)) throw new Error('values is an object: { <control key>: value }.');
  const controls = controlRows(descriptor);
  if (bind === undefined && values === undefined) return { controls };
  return { controls, input: runInput(controls, bind ?? {}, values ?? {}) };
}
