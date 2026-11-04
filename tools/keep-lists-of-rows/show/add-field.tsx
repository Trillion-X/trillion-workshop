//
// Runtime schema editing: "+ Field" builds ONE field descriptor and hands it
// to the owner's append seam (the same fields-record writer the domain editor
// already uses — a runtime DATA write, never re-admission). The editor-shape
// list is ENUMERATED FROM the shape-keyed editor kit registry — no literal
// shape array lives here (enum dissolution: registering a new editor shape in
// the kit makes it appear in this picker with zero edits). A derived column
// (Formula / Ask AI / Linked records) is the same descriptor with a `derive`
// block whose target address is DATA.

import React from 'react';
import { Plus } from 'lucide-react';
import { Button, Card, Container, Dropdown, Icon, Input, Text } from '../../ui';
import { fieldEditorRegistry } from './field-editors';
import { humanize } from './field-editor-kit';
import type { VisualDatabaseEvaluatorDescriptor, VisualDatabaseFieldDescriptor } from '../read-data/visual-database';

export function buildFieldDescriptor(options: {
  label: string;
  shape: string;
  evaluator?: VisualDatabaseEvaluatorDescriptor;
  /** Formula binding AST JSON / relation filter — opaque template merged into derive.request. */
  requestTemplate?: Record<string, unknown>;
  contextFromFields?: readonly string[];
}): VisualDatabaseFieldDescriptor | null {
  const label = options.label.trim();
  if (!label) return null;
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) return null;
  const base: VisualDatabaseFieldDescriptor = {
    id,
    label,
    role: 'metric',
    paths: [['payload', id]],
    writePath: ['payload', id],
    shape: options.shape,
    source: 'declared',
  };
  if (!options.evaluator) return base;
  return {
    ...base,
    defaultExpression: { derive: {
        target: options.evaluator.target,
        evaluatorRef: options.evaluator.ref,
        request: { ...(options.evaluator.request ?? {}), ...(options.requestTemplate ?? {}) },
        resultPath: options.evaluator.resultPath,
        dependencySelector: { ...(options.evaluator.dependencySelector ?? {}), contextFromFields: options.contextFromFields ?? [] },
      } },
  };
}

/** The "+ Field" popover form. Owner supplies the append seam. */
export function AddFieldForm({ existingFields, evaluators = [], onAdd, onClose }: {
  existingFields: readonly VisualDatabaseFieldDescriptor[];
  evaluators?: readonly VisualDatabaseEvaluatorDescriptor[];
  onAdd: (descriptor: VisualDatabaseFieldDescriptor) => void;
  onClose: () => void;
}) {
  const fieldNameId = React.useId();
  const fieldTypeLabelId = React.useId();
  const valueSourceLabelId = React.useId();
  const structuredRequestId = React.useId();
  const structuredRequestHelpId = React.useId();
  const contextFieldsId = React.useId();
  const contextFieldsHelpId = React.useId();
  const shapes = Object.keys(fieldEditorRegistry);
  const [label, setLabel] = React.useState('');
  const [shape, setShape] = React.useState(shapes[0] ?? 'text');
  const [sourceId, setSourceId] = React.useState('literal');
  const [template, setTemplate] = React.useState('');
  const [contextIds, setContextIds] = React.useState('');
  const [templateError, setTemplateError] = React.useState<string | null>(null);
  const selectedEvaluator = sourceId === 'literal'
    ? undefined
    : evaluators.find((entry) => entry.ref === sourceId);
  const needsAdvancedSetup = selectedEvaluator !== undefined && selectedEvaluator.authoring === undefined;
  const submit = () => {
    let requestTemplate: Record<string, unknown> | undefined;
    if (needsAdvancedSetup && template.trim()) {
      try {
        const parsed = JSON.parse(template) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setTemplateError('The structured request must be a JSON object.');
          return;
        }
        requestTemplate = parsed as Record<string, unknown>;
      } catch {
        setTemplateError("That isn't valid JSON yet.");
        return;
      }
    }
    const descriptor = buildFieldDescriptor({
      label,
      shape,
      evaluator: selectedEvaluator,
      requestTemplate,
      contextFromFields: needsAdvancedSetup
        ? contextIds.split(',').map((entry) => entry.trim()).filter(Boolean)
        : undefined,
    });
    if (!descriptor) return;
    if (existingFields.some((field) => field.id === descriptor.id)) {
      setTemplateError('A field with this name already exists.');
      return;
    }
    onAdd(descriptor);
    onClose();
  };
  return (
    <Card
      id="field-editor-overlay"
      role="dialog"
      aria-label="Add field"
      data-testid="field-editor-overlay"
      data-ui-node="field-editor-overlay"
      data-overlay-owner-id="visual-database-fields"
      variant="nested"
      padding="sm"
      layout="stack"
      style={{
        width: 'min(390px, calc(100vw - 32px))',
        maxWidth: '100%',
        maxBlockSize: 'min(36rem, calc(100dvh - 32px))',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
    >
      <Container layout="vertical" gap="xs" padding="none">
        <Text as="label" variant="label" htmlFor={fieldNameId}>Field name</Text>
        <Input
          id={fieldNameId}
          autoFocus
          data-testid="field-name"
          data-ui-node="field-name"
          borderless
          placeholder="Name this field"
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
        />
      </Container>
      <Container layout="vertical" gap="sm" padding="none">
        <Container
          layout="vertical"
          gap="xs"
          padding="none"
          role="group"
          aria-labelledby={fieldTypeLabelId}
        >
          <Text id={fieldTypeLabelId} variant="label">Field type</Text>
          <Dropdown
            aria-label="Field type"
            className="w-full min-w-0 justify-between"
            items={shapes.map((entry) => ({ value: entry, label: humanize(entry) }))}
            value={shape}
            onValueChange={setShape}
          />
        </Container>
        <Container
          layout="vertical"
          gap="xs"
          padding="none"
          role="listbox"
          aria-labelledby={valueSourceLabelId}
        >
          <Text id={valueSourceLabelId} variant="label">Value source</Text>
          {[
            { ref: 'literal', label: 'Typed in' },
            ...evaluators.map((entry) => ({ ref: entry.ref, label: entry.label ?? entry.ref })),
          ].map((entry) => (
            <Button
              key={entry.ref}
              role="option"
              aria-selected={sourceId === entry.ref}
              variant="ghost"
              size="sm"
              className="w-full min-w-0 justify-start"
              data-testid={`value-source-${entry.ref}`}
              data-ui-node="field-value-source-option"
              data-evaluator-ref={entry.ref === 'literal' ? undefined : entry.ref}
              data-value-source-ref={entry.ref}
              active={sourceId === entry.ref}
              onClick={() => {
                setSourceId(entry.ref);
                setTemplate('');
                setContextIds('');
                setTemplateError(null);
              }}
            >
              {entry.label}
            </Button>
          ))}
        </Container>
      </Container>
      {needsAdvancedSetup ? (
        <Container layout="vertical" gap="sm" padding="none">
          <Container layout="vertical" gap="xs" padding="none">
            <Text variant="label" weight="medium">Advanced setup</Text>
            <Text id={structuredRequestHelpId} variant="caption" color="faint">
              This value source has no human editor. Enter its structured request as a JSON object.
            </Text>
            <Text as="label" variant="label" htmlFor={structuredRequestId}>Structured request (JSON)</Text>
            <Input
              id={structuredRequestId}
              aria-describedby={structuredRequestHelpId}
              placeholder='{ "input": "value" }'
              value={template}
              onChange={(event) => { setTemplate(event.currentTarget.value); setTemplateError(null); }}
            />
          </Container>
          <Container layout="vertical" gap="xs" padding="none">
            <Text as="label" variant="label" htmlFor={contextFieldsId}>Uses fields</Text>
            <Input
              id={contextFieldsId}
              aria-describedby={contextFieldsHelpId}
              placeholder="Revenue, cost"
              value={contextIds}
              onChange={(event) => setContextIds(event.currentTarget.value)}
            />
            <Text id={contextFieldsHelpId} variant="caption" color="faint">
              Separate field names with commas.
            </Text>
          </Container>
        </Container>
      ) : null}
      {templateError ? <Text variant="caption" color="faint">{templateError}</Text> : null}
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
        <Button
          variant="primary"
          size="sm"
          data-testid="create-field"
          data-ui-node="create-field"
          disabled={!label.trim()}
          onClick={submit}
        >
          Add field
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </Container>
    </Card>
  );
}

/** The "+" header affordance that opens the form. */
export function AddFieldButton({ existingFields, evaluators = [], onAdd }: {
  existingFields: readonly VisualDatabaseFieldDescriptor[];
  evaluators?: readonly VisualDatabaseEvaluatorDescriptor[];
  onAdd: (descriptor: VisualDatabaseFieldDescriptor) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Container
      id="visual-database-fields"
      role="region"
      aria-label="Fields"
      data-testid="visual-database-fields"
      data-ui-node="visual-database-fields"
      layout="vertical"
      padding="none"
    >
      <Button
        variant="ghost"
        size="xs"
        aria-label="Add field"
        data-testid="add-field"
        active={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={Plus} size="xs" />
      </Button>
      {open ? (
        <AddFieldForm existingFields={existingFields} evaluators={evaluators} onAdd={onAdd} onClose={() => setOpen(false)} />
      ) : null}
    </Container>
  );
}
