// packages/ask-questions-sort-answers-follow-up/show/BuilderView.tsx
//
// Entry View for the builder: reads the question-type registry from the one types file
// (data/question-types.json, the file the server's check and the step pages read) and renders the BuilderSurface. Thin glue — all editing
// is builder-model, all rendering is BuilderSurface + FillSurface preview.

import React from 'react';
import { BuilderSurface } from './BuilderSurface';
import { indexCapabilities, type QuestionTypeCapability } from '../../../read-data/question-descriptor';
import questionTypes from '../../../data/question-types.json' with { type: 'json' };

const registry = indexCapabilities(questionTypes.rows as QuestionTypeCapability[]);

export function BuilderView() {
  return <BuilderSurface registry={registry} />;
}
