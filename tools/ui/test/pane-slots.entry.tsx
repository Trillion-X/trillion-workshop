// The entry the test bundles twice: each bundle is a separate copy of the shared mount code, as a screen module is.
import React from 'react';
import { mountSharedContent } from '../show/coss/shared-content';
import { slotOf } from '../show/pane-slots';
import { releaseNode } from '../show/one-owner-per-node';

export const mount = (pane: HTMLElement, kind: string, words: string) => mountSharedContent(slotOf(pane, kind), React.createElement('p', null, words));
export const release = (pane: HTMLElement, kind: string) => releaseNode(slotOf(pane, kind));
