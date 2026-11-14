// package-set://bitfield-studio/packages/request-intake/show/RequestQuestionList.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders the questions of an intake form from screen-model DATA. One question =
// one card showing its label, its value-kind label, whether it is required, and
// any rules. Every string is finished by the screen model; this file never reads
// a raw field kind, never branches on a kind name, and shows the same card for a
// "short-text" question as for any value kind invented later (L090). Add a field
// to the shape and a card appears here with zero change to this file.
//
// =============================================================================

import {
  Badge,
  Card,
  Container,
  EmptyPlaceholder,
  Text,
} from '@/packages/ui';
import { ListChecks } from 'lucide-react';
import type { RequestIntakeScreenQuestion } from '@/packages/request-intake/show/request-intake-screen-model';

interface RequestQuestionListProps {
  questions: RequestIntakeScreenQuestion[];
  emptyCopy: string;
}

export function RequestQuestionList({ questions, emptyCopy }: RequestQuestionListProps): JSX.Element {
  if (questions.length === 0) {
    return <EmptyPlaceholder icon={ListChecks} message={emptyCopy} />;
  }

  return (
    <Container layout="vertical" gap="sm">
      {questions.map((question) => (
        <Card key={question.id} variant="nested" padding="md" layout="stack">
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
            <Text variant="body" weight="medium">{question.label}</Text>
            <Badge variant={question.required ? 'accent' : 'muted-outline'} size="sm">
              {question.requiredLabel}
            </Badge>
          </Container>
          <Text variant="caption" color="muted">{question.valueKindLabel}</Text>
          {question.rules.length > 0 ? (
            <Container layout="horizontal" gap="xs" alignItems="center">
              {question.rules.map((rule) => (
                <Badge key={rule.id} variant="muted-outline" size="sm">{rule.label}</Badge>
              ))}
            </Container>
          ) : null}
        </Card>
      ))}
    </Container>
  );
}
