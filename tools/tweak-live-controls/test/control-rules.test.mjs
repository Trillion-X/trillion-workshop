// Every kind of tool input gets the control it got before the widget branches became the rows of control-rules.json
// (the expected rows were read from made-controls.mjs before that change, Nov 18 2026), and an input no row holds for
// (an object, a list of free words) has no control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlRows } from '../made-controls.mjs';

const every = { id: 'tool:every-input', label: 'Every input', invoke: { kind: 'process' }, input_schema: { type: 'object', properties: {
  warmth: { type: 'number', minimum: 0, maximum: 100, default: 40 },
  frames: { type: 'integer', minimum: 1, maximum: 10 },
  stops: { type: 'number', minimum: 0, maximum: 1, enum: [0, 0.5, 1] },
  speed: { type: 'number', minimum: 0 },
  count: { type: 'integer', enum: [1, 2, 3] },
  loud: { type: 'boolean' },
  muted: { type: 'boolean', default: true },
  mood: { type: 'string', enum: ['calm', 'bright', null] },
  city: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
  tags: { type: 'array', items: { enum: ['x', 'y'] }, default: ['x'] },
  open_tags: { type: 'array', items: { type: 'string' } },
  note: { type: 'string', title: 'A note' },
  either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  nullable: { type: ['number', 'null'], minimum: 0, maximum: 9 },
  shape: { type: 'object' },
} } };

const expected = [
 {
  "key": "warmth",
  "label": "Warmth",
  "widget": "slider",
  "integer": false,
  "min": 0,
  "max": 100,
  "step": 1,
  "default_value": 40
 },
 {
  "key": "frames",
  "label": "Frames",
  "widget": "slider",
  "integer": true,
  "min": 1,
  "max": 10,
  "step": 1
 },
 {
  "key": "stops",
  "label": "Stops",
  "widget": "slider",
  "integer": false,
  "options": [
   {
    "value": "0",
    "label": "0"
   },
   {
    "value": "0.5",
    "label": "0.5"
   },
   {
    "value": "1",
    "label": "1"
   }
  ],
  "min": 0,
  "max": 1,
  "step": 0.01
 },
 {
  "key": "speed",
  "label": "Speed",
  "widget": "number",
  "integer": false,
  "min": 0
 },
 {
  "key": "count",
  "label": "Count",
  "widget": "number",
  "integer": true,
  "options": [
   {
    "value": "1",
    "label": "1"
   },
   {
    "value": "2",
    "label": "2"
   },
   {
    "value": "3",
    "label": "3"
   }
  ]
 },
 {
  "key": "loud",
  "label": "Loud",
  "widget": "toggle",
  "default_value": false
 },
 {
  "key": "muted",
  "label": "Muted",
  "widget": "toggle",
  "default_value": true
 },
 {
  "key": "mood",
  "label": "Mood",
  "widget": "choices",
  "options": [
   {
    "value": "calm",
    "label": "Calm"
   },
   {
    "value": "bright",
    "label": "Bright"
   }
  ]
 },
 {
  "key": "city",
  "label": "City",
  "widget": "select",
  "options": [
   {
    "value": "a",
    "label": "A"
   },
   {
    "value": "b",
    "label": "B"
   },
   {
    "value": "c",
    "label": "C"
   },
   {
    "value": "d",
    "label": "D"
   },
   {
    "value": "e",
    "label": "E"
   },
   {
    "value": "f",
    "label": "F"
   },
   {
    "value": "g",
    "label": "G"
   }
  ]
 },
 {
  "key": "tags",
  "label": "Tags",
  "widget": "many",
  "options": [
   {
    "value": "x",
    "label": "X"
   },
   {
    "value": "y",
    "label": "Y"
   }
  ],
  "default_value": [
   "x"
  ]
 },
 {
  "key": "note",
  "label": "A note",
  "widget": "words"
 },
 {
  "key": "either",
  "label": "Either",
  "widget": "words"
 },
 {
  "key": "nullable",
  "label": "Nullable",
  "widget": "slider",
  "integer": false,
  "min": 0,
  "max": 9,
  "step": 0.01
 }
];

test('every input kind gets its control from the rows, as before', () => {
  assert.deepEqual(controlRows(every).settings, expected);
});
