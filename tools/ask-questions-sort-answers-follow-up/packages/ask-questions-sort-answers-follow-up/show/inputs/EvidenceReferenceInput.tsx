// packages/ask-questions-sort-answers-follow-up/show/inputs/EvidenceReferenceInput.tsx
//
// Generic callback-backed input for an opaque evidence reference. The owner of
// the callback decides how (or whether) a source is opened. This leaf has no
// recorder/file/link/connection branches and makes no completion claim when the
// callback is absent.

import React from 'react';
import { CheckCircle2, FileSearch } from 'lucide-react';
import { Button } from '@/packages/ui/show/button/Button';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { QuestionField } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs/QuestionField';
import { isEvidenceReference } from '@/packages/ask-questions-sort-answers-follow-up/read-data/evidence-reference';
import type { QuestionInputProps } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract';

export function EvidenceReferenceInput({
  label,
  value,
  onChange,
  requestValue,
  required,
  error,
}: QuestionInputProps) {
  const [requesting, setRequesting] = React.useState(false);
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const attached = isEvidenceReference(value);
  const requestEpoch = React.useRef(0);
  React.useEffect(() => () => { requestEpoch.current += 1; }, []);

  const requestReference = async () => {
    if (!requestValue || requesting) return;
    const epoch = ++requestEpoch.current;
    setRequesting(true);
    setRequestError(null);
    try {
      const next = await requestValue();
      if (epoch !== requestEpoch.current) return;
      if (next !== null && next !== undefined) {
        if (!isEvidenceReference(next)) throw new Error('The source did not return a valid result.');
        onChange(next);
      }
    } catch (reason) {
      if (epoch !== requestEpoch.current) return;
      setRequestError(reason instanceof Error ? reason.message : 'Could not add source');
    } finally {
      if (epoch === requestEpoch.current) setRequesting(false);
    }
  };

  return (
    <QuestionField
      label={label}
      required={required}
      error={error ?? requestError}
    >
      <Card variant={attached ? 'solid' : 'nested'} padding="md">
        <Container layout="responsive-split" gap="md" alignItems="center" justifyContent="between">
          <Container layout="horizontal" gap="sm" alignItems="center">
            {attached
              ? <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-status-success" />
              : <FileSearch aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" />}
            <Text variant="body" color={attached ? 'primary' : 'muted'} weight={attached ? 'semibold' : 'normal'}>
              {attached
                ? 'Added'
                : requestValue
                  ? 'Nothing from this source is attached yet'
                  : 'No source is available here'}
            </Text>
          </Container>
          {requestValue ? (
            <Button
              type="button"
              variant={attached ? 'ghost' : 'secondary'}
              size="md"
              disabled={requesting}
              onClick={requestReference}
            >
              {requesting ? 'Opening source' : attached ? 'Replace source' : 'Add source'}
            </Button>
          ) : null}
        </Container>
      </Card>
    </QuestionField>
  );
}
