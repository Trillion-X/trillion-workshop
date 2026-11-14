import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Layers3, Play, Shuffle, Sparkles } from 'lucide-react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Dropdown } from '@/packages/ui/show/dropdown';
import { Icon } from '@/packages/ui/show/icon';
import { Textarea } from '@/packages/ui/show/input';
import { sanitizeErrorText } from '@/packages/ui/show/safe-error-card';
import { ScrollableSurface } from '@/packages/ui/show/scrollable-surface';
import { Text } from '@/packages/ui/show/text';
import {
  deriveContentProductionStep,
  contentProductionCompositionCatalog,
  firstActionInvocationDescriptor,
  firstSelectionInput,
  firstRunProfile,
  readContentProductionEvidence,
  readSelectionOptions,
  readSourceOptions,
  sourceInputs,
} from '@/packages/content-production/read-data/read-content-production';
import { submitContentProductionRun } from '@/packages/content-production/do-work/submit-content-production-run';

export function ContentProduction() {
  const evidenceRows = useBitfieldData('content-production:contentMediaEvidence');
  const evidence = React.useMemo(
    () => readContentProductionEvidence(evidenceRows),
    [evidenceRows],
  );
  const runProfile = firstRunProfile(evidence.runProfiles);
  const actionDescriptor = firstActionInvocationDescriptor(evidence);
  const selectionInput = firstSelectionInput(runProfile);
  const sourceInputList = sourceInputs(runProfile);
  const selectionOptions = React.useMemo(
    () => readSelectionOptions(evidenceRows, selectionInput),
    [evidenceRows, selectionInput],
  );
  const sourceOptions = React.useMemo(
    () => sourceInputList.flatMap((input) => readSourceOptions(evidenceRows, input)),
    [evidenceRows, sourceInputList],
  );
  const [promptText, setPromptText] = React.useState('');
  const [selectionId, setSelectionId] = React.useState('');
  const catalog = contentProductionCompositionCatalog;
  const [sourceIds, setSourceIds] = React.useState<string[]>([]);
  const [knowledgeSourceId, setKnowledgeSourceId] = React.useState(catalog.knowledgeSources[0]?.id ?? '');
  const [formatId, setFormatId] = React.useState(catalog.formats[0]?.id ?? '');
  const [pillarIds, setPillarIds] = React.useState<string[]>(catalog.contentPillars[0] ? [catalog.contentPillars[0].id] : []);
  const [destinationIds, setDestinationIds] = React.useState<string[]>(catalog.destinations[0] ? [catalog.destinations[0].id] : []);
  const [variationCountId, setVariationCountId] = React.useState(catalog.variationCounts[0]?.id ?? '1');
  const [variationAxisIds, setVariationAxisIds] = React.useState<string[]>([]);
  const [statusText, setStatusText] = React.useState('');
  const [isRunning, setIsRunning] = React.useState(false);

  React.useEffect(() => {
    if (selectionOptions[0] && !selectionOptions.some((option) => option.id === selectionId)) {
      setSelectionId(selectionOptions[0].id);
    }
  }, [selectionId, selectionOptions]);

  React.useEffect(() => {
    setSourceIds((current) => {
      const available = current.filter((id) => sourceOptions.some((option) => option.id === id));
      return available.length > 0 || !sourceOptions[0] ? available : [sourceOptions[0].id];
    });
  }, [sourceOptions]);

  const selectedOption = selectionOptions.find((option) => option.id === selectionId);
  const selectedSourceOptions = sourceOptions.filter((option) => sourceIds.includes(option.id));
  const selectedSourceOption = selectedSourceOptions[0];
  const effectivePromptText = promptText.trim() || (selectedSourceOption ? 'Create from the selected sources.' : '');
  const needsSource = sourceInputList.length > 0;
  const step = deriveContentProductionStep({
    evidence,
    runProfile,
    promptText: effectivePromptText,
    needsSource,
    selectedSource: selectedSourceOption,
    needsSelection: !!selectionInput,
    selectionInput,
    selectedSelection: selectedOption,
    isSubmitting: isRunning,
  });
  const variationCount = catalog.variationCounts.find((choice) => choice.id === variationCountId)?.value ?? 1;
  const canStart = step.canSubmit
    && !!knowledgeSourceId
    && !!formatId
    && pillarIds.length > 0
    && destinationIds.length > 0
    && !isRunning;

  function toggleChoice(id: string, values: string[], setValues: React.Dispatch<React.SetStateAction<string[]>>) {
    setValues(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  }

  async function handleStart() {
    if (!canStart) return;
    setIsRunning(true);
    setStatusText('Starting...');
    try {
      await submitContentProductionRun({
        promptText: effectivePromptText,
        runProfile,
        sources: selectedSourceOptions.length ? selectedSourceOptions.map((option) => option.sourceRef) : undefined,
        composition: {
          schema: catalog.schema,
          knowledge_source_id: knowledgeSourceId,
          content_format_id: formatId,
          content_pillar_ids: pillarIds,
          destination_ids: destinationIds,
          variation_count: variationCount,
          variation_axis_ids: variationAxisIds,
          source_ids: selectedSourceOptions.map((option) => option.id),
          cross_pollination: selectedSourceOptions.length >= catalog.crossPollination.minInputs,
        },
        metadata: {
          ...(selectedSourceOptions.length ? {
            source_ids: selectedSourceOptions.map((option) => option.id),
            sources: selectedSourceOptions.map((option) => ({
              source_id: option.id,
              source_package: option.input.evidence_package,
              role: option.input.role,
              label: option.label,
            })),
            ...(selectedSourceOption ? {
              [selectedSourceOption.input.metadata_id_key ?? `${selectedSourceOption.input.metadata_key ?? 'source'}_id`]: selectedSourceOption.id,
              [selectedSourceOption.input.metadata_key ?? 'source']: {
                source_id: selectedSourceOption.id,
                source_package: selectedSourceOption.input.evidence_package,
                role: selectedSourceOption.input.role,
                label: selectedSourceOption.label,
              },
            } : {}),
          } : {}),
          ...(selectionInput && selectedOption ? {
            [selectionInput.metadata_id_key ?? `${selectionInput.metadata_key ?? 'selection'}_id`]: selectedOption.id,
            [selectionInput.metadata_key ?? 'selection']: selectedOption.raw,
          } : {}),
          title: promptText.split('\n').find((line) => line.trim())?.slice(0, 120) ?? 'Production output',
        },
      }, actionDescriptor ?? {});
      setPromptText('');
      setStatusText('Making it now.');
    } catch (error) {
      // Raw error text never reaches visible copy — the shared sanitation
      // gate strips stack frames, paths, addresses, and hashes first.
      setStatusText(sanitizeErrorText(
        error instanceof Error ? error.message : null,
        'Could not start. Nothing was changed.',
      ));
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <ScrollableSurface>
      <Container
        layout="vertical"
        gap="lg"
        height="full"
        className="bg-[radial-gradient(circle_at_top_right,var(--glass-bg-subtle),transparent_34%),linear-gradient(135deg,var(--surface-primary),var(--surface-secondary))] p-4 sm:p-6 lg:p-10"
      >
        <Card
          variant="surface"
          padding="lg"
          layout="stack"
          className="mx-auto w-full max-w-5xl flex-1"
          data-testid="content-production-primary"
        >
          <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm" wrap>
            <Container layout="horizontal" alignItems="center" gap="sm" wrap>
              <Icon icon={Sparkles} size="sm" />
              <Text variant="heading">Create from what already works</Text>
            </Container>
            <Badge variant={step.tone === 'success' ? 'success' : step.tone === 'error' ? 'error' : 'accent'} size="sm">
              {step.label}
            </Badge>
          </Container>
          <Text variant="caption" color="faint">Choose the source, shape, audience angle, and destination. Every result keeps those choices and its source history.</Text>

          <Container layout="horizontal" gap="sm" alignItems="center" wrap>
            <Dropdown
              items={catalog.knowledgeSources.map((choice) => ({ value: choice.id, label: choice.label, description: choice.description }))}
              value={knowledgeSourceId}
              onValueChange={setKnowledgeSourceId}
              placeholder="Knowledge"
              aria-label="Knowledge source"
              scrollable
            />
            <Dropdown
              items={catalog.formats.map((choice) => ({ value: choice.id, label: choice.label }))}
              value={formatId}
              onValueChange={setFormatId}
              placeholder="Format"
              aria-label="Output format"
              scrollable
            />
            <Dropdown
              items={catalog.variationCounts.map((choice) => ({ value: choice.id, label: choice.label }))}
              value={variationCountId}
              onValueChange={setVariationCountId}
              placeholder="Versions"
              aria-label="Number of versions"
            />
          </Container>

          <Container layout="vertical" gap="sm">
            <Text variant="label">Tell it through</Text>
            <Container layout="horizontal" gap="sm" wrap>
              {catalog.contentPillars.map((choice) => (
                <Button
                  key={choice.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  active={pillarIds.includes(choice.id)}
                  onClick={() => toggleChoice(choice.id, pillarIds, setPillarIds)}
                >
                  {choice.label}
                </Button>
              ))}
            </Container>
          </Container>

          <Container layout="vertical" gap="sm">
            <Text variant="label">Make it for</Text>
            <Container layout="horizontal" gap="sm" wrap>
              {catalog.destinations.map((choice) => (
                <Button
                  key={choice.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  active={destinationIds.includes(choice.id)}
                  onClick={() => toggleChoice(choice.id, destinationIds, setDestinationIds)}
                >
                  {choice.label}
                </Button>
              ))}
            </Container>
          </Container>

          <Textarea
            aria-label="Desired output"
            value={promptText}
            onChange={(event) => setPromptText(event.currentTarget.value)}
            placeholder="Add direction, or leave the source and format to lead."
            className="min-h-[24vh] resize-none text-base leading-8"
          />

          <details>
            <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)]">Shape the variations</summary>
            <Container layout="horizontal" gap="sm" wrap className="pt-3">
              {catalog.variationAxes.map((choice) => (
                <Button
                  key={choice.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  active={variationAxisIds.includes(choice.id)}
                  onClick={() => toggleChoice(choice.id, variationAxisIds, setVariationAxisIds)}
                >
                  {choice.label}
                </Button>
              ))}
            </Container>
          </details>
          <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm" wrap>
            <Button variant="primary" disabled={!canStart} onClick={handleStart}>
              <Icon icon={Play} size="sm" />
              {isRunning ? 'Making it' : step.actionLabel}
            </Button>
            <Container layout="horizontal" gap="sm" alignItems="center" wrap>
              {selectedSourceOptions.length >= catalog.crossPollination.minInputs ? (
                <Badge variant="accent" size="sm"><Icon icon={Shuffle} size="sm" />Cross-pollinating {selectedSourceOptions.length} sources</Badge>
              ) : null}
              {variationCount > 1 ? <Badge variant="neutral" size="sm"><Icon icon={Layers3} size="sm" />{variationCount} saved versions</Badge> : null}
              {statusText ? <Text variant="caption" color="accent">{statusText}</Text> : null}
            </Container>
          </Container>
        </Card>

        <details className="mx-auto w-full max-w-5xl px-1 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)]">Sources and project</summary>
          <Container layout="vertical" gap="sm" className="pt-3">
            {selectionInput && selectionOptions.length > 1 ? (
              <Dropdown
                items={selectionOptions.map((option) => ({ value: option.id, label: option.label }))}
                value={selectionId}
                onValueChange={setSelectionId}
                placeholder={selectionInput.label ?? 'Selection'}
                aria-label={selectionInput.label ?? 'Production selection'}
                align="end"
              />
            ) : null}
            <Container layout="horizontal" gap="sm" wrap>
              {sourceOptions.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  active={sourceIds.includes(option.id)}
                  onClick={() => toggleChoice(option.id, sourceIds, setSourceIds)}
                >
                  {option.label}
                </Button>
              ))}
            </Container>
            <Text variant="caption" color="faint">
              {selectedSourceOptions.length ? `${selectedSourceOptions.length} source${selectedSourceOptions.length === 1 ? '' : 's'} selected. ` : ''}
              {selectedOption ? `Destination: ${selectedOption.label}.` : ''}
            </Text>
          </Container>
        </details>
      </Container>
    </ScrollableSurface>
  );
}
