// packages/interaction-program/show/mount-community-feed.tsx
//
// =============================================================================
// PURPOSE: the MEMBER-facing Community FEED (task #40). Members open "Community"
// and see the program's announcements plus member posts as a scannable feed.
// This is the customer-facing twin of the operator `community-console`: the
// same domain owner (interaction-program) rendering its own community DATA for
// a different audience. Reference-grounded screen contract:
//   notes/projects/stop-looking-start-seeing-program/plans/
//   2026-07-30-find-your-calling-program/2026-08-05-community-feed-screen-contract.md
//
// NON-NEGOTIABLE INVARIANTS:
// 1. DATA-driven: posts come from the bound `posts_input` feed of
//    `community-post` records. A new post is a new record, ZERO code change
//    (L090). No hardcoded post content, no hardcoded author name.
// 2. Human copy only. No internal vocabulary (community-post, record, feed
//    address, write-batch, interaction-program) in the UI (L114/L118).
// 3. Shared `ui` primitives ONLY, and ONLY the prop subset proven by the
//    sibling `mount-community-console.tsx` (Container padding; Text size/tone/
//    weight; Badge tone; Button variant/size; Card padding; Divider). No AI/
//    scheduling/storage logic (no god package).
// 4. Fail-soft: an unbound input never reaches useBitfieldData('') (the
//    read-scope crash). Honest empty state, never blank filler (L117).
// 5. Read-focused phase 1 (announcements). Avatars, inline Like/Reply, and the
//    composer are phase 2, added once the surface can be render-verified on a
//    staging root against the real `ui` layout API.
//
// The extensive documentation here is a design feature; do not remove it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Badge,
  Card,
  Divider,
  ErrorBoundary,
  Text,
  mountReactSurface,
} from '../../../../ui';
import { buildPostModels } from '../read-data/feed-selectors.mjs';

// An always-declared input used ONLY as a safe fallback NAME so an unbound
// optional input never reaches useBitfieldData('') and crashes the surface.
const SAFE_FALLBACK_INPUT = 'interaction-program-list';

function useOptionalInput(name: string | undefined): unknown {
  const raw = useBitfieldData(name || SAFE_FALLBACK_INPUT);
  return name ? raw : undefined;
}

type SurfaceInput = {
  // Name of the bound input carrying the community-post feed (a json array of
  // community-post records).
  posts_input?: string;
};

type PostModel = ReturnType<typeof buildPostModels>[number];

// ---------------------------------------------------------------------------
// One post card (announcement or member post)
// ---------------------------------------------------------------------------
function PostCard({ post }: { post: PostModel }) {
  return (
    <Card padding="md">
      <Text weight="semibold" size="sm">{post.author}</Text>
      {post.isOperator ? <Badge tone="neutral">Team</Badge> : null}
      {post.relative ? <Text tone="muted" size="sm">{post.relative}</Text> : null}
      {post.title ? <Text weight="semibold" size="sm">{post.title}</Text> : null}
      <Text size="sm">{post.body}</Text>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ROOT
// ---------------------------------------------------------------------------
function CommunityFeedRoot({ surfaceInput }: { surfaceInput: SurfaceInput }) {
  const postsRaw = useOptionalInput(surfaceInput.posts_input);
  const nowMs = Date.now();
  const posts = React.useMemo(() => buildPostModels(postsRaw, nowMs), [postsRaw, nowMs]);

  return (
    <Card padding="lg">
      <Text weight="semibold" size="lg">Community</Text>
      <Text tone="muted" size="sm">
        The shared room for everyone on the calling journey. Announcements, prompts, and wins.
      </Text>
      <Divider />
      {posts.length === 0 ? (
        <Card padding="md">
          <Text weight="semibold" size="sm">Be the first to share</Text>
          <Text tone="muted" size="sm">
            Post where you are stuck, what just clicked, or a win as it lands. Others reading yours is often the exact nudge they needed.
          </Text>
        </Card>
      ) : (
        posts.map((post) => <PostCard key={post.id} post={post} />)
      )}
    </Card>
  );
}

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

export default function mount({ el, props = {} }: MountArgs) {
  // Read BOTH surface_input and surfaceInput (hosts may camelize); an undefined
  // input name must never reach useBitfieldData('').
  const surfaceInput = (props.surfaceInput ?? props.surface_input ?? {}) as SurfaceInput;
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="community feed">
      <CommunityFeedRoot surfaceInput={surfaceInput} />
    </ErrorBoundary>,
  );
}
