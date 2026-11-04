// PORTED FROM: bitfield-packages/packages/chat/show/mount-chat.tsx @ e99ac5976
import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { ChatView } from './ChatView';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ChatMaterial({ props }: { props: Record<string, unknown> }) {
  // When embedded (a board node, a split pane), the host hands the node's
  // `surfaceInput` DATA through verbatim. ChatView may select an opaque source,
  // focus an opaque conversation, seed its first assistant turn while canonical
  // history loads, or select an addressed participant. Standalone passes no
  // surfaceInput and keeps the normal all-sources default.
  const surfaceInput =
    props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
      ? (props.surfaceInput as Record<string, unknown>)
      : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame} className="h-full min-h-0 overflow-hidden">
      <ErrorBoundary zoneName="chat material">
        <div className="h-full min-h-0 overflow-hidden">
          <ChatView surfaceInput={surfaceInput} />
        </div>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ChatMaterial props={props} />);
}
