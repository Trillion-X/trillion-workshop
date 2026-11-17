import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Button } from '../../../../ui/show/button';
import { Container } from '../../../../ui/show/container';
import { Text } from '../../../../ui/show/text';
import {
  buildRecordCustomerStepInput,
  recordCustomerStep,
} from '../do-work/record-customer-step';
import { useMeasureEngine } from 'trillion-workshop/tools/keep-lists-of-rows/show/use-measure-engine.ts';
import {
  customerFollowUpViews,
  readCustomerFollowUpState,
} from '../../../read-data/read-customer-follow-up';

type CustomerFollowUpSurfaceProps = {
  actorId?: string;
  productId?: string;
};

export function CustomerFollowUpSurface({ actorId, productId }: CustomerFollowUpSurfaceProps) {
  const rows = useBitfieldData('published-records');
  const state = React.useMemo(() => readCustomerFollowUpState(rows), [rows]);
  const [selectedContactId, setSelectedContactId] = React.useState<string | undefined>();
  const [message, setMessage] = React.useState<string | null>(null);
  // Each product's customer count is the formula engine's: the page fetches it here, and the progress rows draw once it is held.
  const measuresReady = useMeasureEngine();
  const views = React.useMemo(
    () => customerFollowUpViews(measuresReady ? state : { ...state, targets: [] }, selectedContactId),
    [measuresReady, selectedContactId, state],
  );
  const selectedProductId = productId ?? views.selectedContact?.lastProductId ?? views.products[0]?.target.productId;

  React.useEffect(() => {
    if (!selectedContactId && views.contacts[0]) setSelectedContactId(views.contacts[0].contact.contactId);
  }, [selectedContactId, views.contacts]);

  const recordFollowUp = React.useCallback(async () => {
    if (!views.selectedContact || !selectedProductId) {
      setMessage('Choose a customer and product first.');
      return;
    }
    await recordCustomerStep(buildRecordCustomerStepInput({
      actorId,
      contactId: views.selectedContact.contact.contactId,
      productId: selectedProductId,
      stepKind: 'follow-up',
      label: 'Follow-up recorded',
      outcome: 'Saved',
    }));
    setMessage('Follow-up recorded.');
  }, [actorId, selectedProductId, views.selectedContact]);

  return (
    <Container layout="vertical" gap="md">
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="space-between" wrap>
        <Text variant="heading">Customer Follow-Up</Text>
        <Button type="button" variant="primary" onClick={() => void recordFollowUp()}>
          Record follow-up
        </Button>
      </Container>

      <Container layout="grid" gridCols={3} gap="md">
        {views.products.map((product) => (
          <Container key={product.target.productId} layout="vertical" gap="xs">
            <Text variant="body" weight="semibold">{product.target.productLabel}</Text>
            <progress max={100} value={product.percent} aria-label={`${product.target.productLabel} customers`} />
            <Text variant="body-xs" color="muted">
              {product.customerCount} of {product.targetCount} customers
            </Text>
            <Text variant="body-xs" color="muted">{product.remainingCount} remaining</Text>
          </Container>
        ))}
        {views.products.length === 0 ? <Text variant="body" color="muted">No customer targets yet.</Text> : null}
      </Container>

      <Container layout="grid" gridCols={2} gap="md">
        <Container layout="vertical" gap="xs">
          {views.contacts.map((view) => (
            <Button
              key={view.contact.contactId}
              type="button"
              variant="secondary"
              active={view.contact.contactId === views.selectedContact?.contact.contactId}
              onClick={() => setSelectedContactId(view.contact.contactId)}
            >
              {view.contact.displayName}
            </Button>
          ))}
          {views.contacts.length === 0 ? <Text variant="body">No customers yet.</Text> : null}
        </Container>

        {views.selectedContact ? (
          <Container layout="vertical" gap="md">
            <Container layout="vertical" gap="xs">
              <Text variant="heading-lg" leading="tight">{views.selectedContact.contact.displayName}</Text>
              {views.selectedContact.contact.channelLabel ? (
                <Text variant="body" color="muted">{views.selectedContact.contact.channelLabel}</Text>
              ) : null}
              {views.selectedContact.lastStep ? (
                <Text variant="body">{views.selectedContact.lastStep.label}</Text>
              ) : (
                <Text variant="body" color="muted">No follow-up yet.</Text>
              )}
            </Container>
            <Container layout="vertical" gap="xs">
              <Text variant="body" color="muted">Timeline</Text>
              {views.selectedContact.steps.map((step) => (
                <Container key={step.stepId} layout="horizontal" gap="sm" justifyContent="space-between" wrap>
                  <Text variant="body-xs">{step.label}</Text>
                  <Text variant="body-xs" color="muted">{step.createdAt}</Text>
                </Container>
              ))}
            </Container>
          </Container>
        ) : null}
      </Container>

      {message ? <Text variant="body-xs" color="success">{message}</Text> : null}
    </Container>
  );
}
