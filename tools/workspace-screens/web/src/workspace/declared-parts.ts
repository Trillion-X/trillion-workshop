// src/workspace/declared-parts.ts
//
// PURPOSE
//   The shared parts a parts screen (parts-screen.tsx) may draw, by the name their row in parts/ui/declared-props.json
//   carries. The row says what the part takes; this says which component it is. Naming each one here (not the whole
//   library) keeps a page that draws parts screens from carrying every part the library has.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every row of parts/ui/declared-props.json has its component here and nothing else is here
//      (test/screen-spec.test.mjs checks both ways).

import type * as React from 'react';
import { Badge, Button, Card, ChoiceTiles, CompletionRing, Container, Divider, Input, ScoreRing, Slider, Switch, Text, Textarea } from '../../parts/ui';

export const declaredComponents: Record<string, React.ElementType> = {
  Badge, Button, Card, ChoiceTiles, CompletionRing, Container, Divider, Input, ScoreRing, Slider, Switch, Text, Textarea,
};
