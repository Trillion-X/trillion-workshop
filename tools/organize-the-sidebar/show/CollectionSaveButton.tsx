// A blind button that turns the current selection into a saved collection.

import React from 'react';
import { Button } from '../../ui';

export function collectionSaveLabel(count: number): string {
  if (count <= 0) return 'Save as collection';
  if (count === 1) return 'Save 1 item as collection';
  return `Save ${count} items as collection`;
}

export interface CollectionSaveButtonProps {
  readonly count: number;
  readonly onSave: () => void;
}

export function CollectionSaveButton(props: CollectionSaveButtonProps): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Save selection as collection"
      disabled={props.count <= 0}
      onClick={props.onSave}
    >
      {collectionSaveLabel(props.count)}
    </Button>
  );
}
