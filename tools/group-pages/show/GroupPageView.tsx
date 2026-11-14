import React, { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Send, Users } from 'lucide-react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  Badge,
  Button,
  Card,
  Container,
  emitPlaceableSurfaceIntent,
  PlaceableSurfaceHost,
  ScrollableSurface,
  Text,
} from '../../ui/index.ts';
import { createGroupPost, readGroupPosts } from '../do-work/create-group-post.ts';
import { ensureGroupMembership } from '../do-work/ensure-group-membership';
import { decodeGroupPagesFeed, type GroupPageItem } from '../read-data/read-group-page.ts';
import { findSubjectSurfaces } from '../read-data/read-subject-surfaces.ts';
import { loadSurfaceCollectionsGraph } from '@/packages/sidebar/do-work/edit-surface-collections';
import { readSurfaceCollections, type SurfaceCollection } from '@/packages/sidebar/read-data/read-surface-collections';
import { emitWalkthroughEvent } from '@/packages/guided-overlay/show/WalkthroughHost';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

const BROWSER_ID_STORAGE_KEY = 'bitfield.account-session.browser-id';
const SESSION_TARGET = 'account-session.browser-session';

type AuthenticationState = 'checking' | 'anonymous' | 'signed-in';
type MembershipState = 'checking' | 'anonymous' | 'joining' | 'joined' | 'error';

function decodeTargetValue(reply: unknown): unknown {
  const candidate = reply && typeof reply === 'object' && 'payload' in reply
    ? (reply as { payload?: unknown }).payload
    : reply;
  if (candidate instanceof Uint8Array || ArrayBuffer.isView(candidate)) {
    const bytes = candidate instanceof Uint8Array
      ? candidate
      : new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
    const body = new TextDecoder().decode(bytes).trim();
    return body ? JSON.parse(body) : {};
  }
  if (candidate instanceof ArrayBuffer) {
    const body = new TextDecoder().decode(new Uint8Array(candidate)).trim();
    return body ? JSON.parse(body) : {};
  }
  if (typeof candidate === 'string') return candidate.trim() ? JSON.parse(candidate) : {};
  return candidate;
}

function replyHasSignedInSession(reply: unknown): boolean {
  const value = decodeTargetValue(reply);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  const session = root.session && typeof root.session === 'object' && !Array.isArray(root.session)
    ? root.session as Record<string, unknown>
    : root;
  return [session.accountIdHash, session.accountId, session.account_id_hash, session.account_id]
    .some((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
}

type SignInSurfaceDescriptor = {
  packageName: string;
  entryName: string;
  materialTarget: string;
  target?: string;
  surfaceInput?: Record<string, unknown>;
};

function readSignInSurface(value: unknown): SignInSurfaceDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const packageEntry = row.package_entry && typeof row.package_entry === 'object' && !Array.isArray(row.package_entry)
    ? row.package_entry as Record<string, unknown>
    : null;
  const packageName = typeof packageEntry?.package_name === 'string' ? packageEntry.package_name.trim() : '';
  const entryName = typeof packageEntry?.entry_name === 'string' ? packageEntry.entry_name.trim() : '';
  const materialTarget = typeof row.material_target === 'string' ? row.material_target.trim() : '';
  if (!packageName || !entryName || !materialTarget) return null;
  return {
    packageName,
    entryName,
    materialTarget,
    ...(typeof row.target === 'string' && row.target.trim() ? { target: row.target.trim() } : {}),
    ...(row.surface_input && typeof row.surface_input === 'object' && !Array.isArray(row.surface_input)
      ? { surfaceInput: row.surface_input as Record<string, unknown> }
      : {}),
  };
}

function useCompactCommunityLayout(): boolean {
  const query = '(max-width: 1024px)';
  const [compact, setCompact] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.(query);
    if (!media) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

function readCreatedItem(reply: unknown, fallbackBody: string): GroupPageItem {
  const value = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
  const row = value.row && typeof value.row === 'object' ? value.row as Record<string, unknown> : {};
  const fields = row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : {};
  return {
    itemRef: String(value.item_ref ?? row.item_ref ?? `post:${crypto.randomUUID()}`),
    text: String(fields.body ?? fields.text ?? fallbackBody),
    authorRef: String(row.actor_ref ?? row.created_by ?? 'You'),
    createdAt: String(row.created_at ?? row.updated_at ?? new Date().toISOString()),
  };
}

function readCreatedItems(reply: unknown): GroupPageItem[] {
  const value = decodeTargetValue(reply);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rows = Array.isArray((value as Record<string, unknown>).rows) ? (value as Record<string, unknown>).rows as unknown[] : [];
  return rows.map((row) => readCreatedItem({ row }, '')).filter((item) => item.text.trim());
}

function mergeItems(staticItems: GroupPageItem[], dynamicItems: GroupPageItem[]): GroupPageItem[] {
  const seen = new Set<string>();
  return [...dynamicItems, ...staticItems]
    .filter((item) => item.itemRef && !seen.has(item.itemRef) && seen.add(item.itemRef))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readCollectionScope(value: unknown, fallbackGroupRef: string): string {
  const explicit = text(value);
  return explicit || `community:${fallbackGroupRef}`;
}

type FirstPostWalkthroughConfig = {
  readyEventKind: string;
  completedEventKind: string;
  onceKey: string;
  progressScope: string;
};

function readFirstPostWalkthroughConfig(value: unknown): FirstPostWalkthroughConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  const onceKey = text(config.once_key);
  const progressScope = text(config.progress_scope) || 'local';
  if (!onceKey) return null;
  return {
    readyEventKind: text(config.ready_event_kind) || 'community-feed-ready',
    completedEventKind: text(config.completed_event_kind) || 'community-first-post-created',
    onceKey,
    progressScope,
  };
}

function openSurface(surface: ReturnType<typeof findSubjectSurfaces>[number]) {
  emitPlaceableSurfaceIntent({
    version: 1,
    id: surface.ref,
    title: surface.label,
    target: surface.target ?? null,
    materialTarget: surface.materialTarget,
    packageEntry: surface.packageEntry ?? null,
    icon: surface.icon,
    surfaceInput: surface.surfaceInput,
  });
}

export function GroupPageView({ props }: { props: Record<string, unknown> }) {
  const compactLayout = useCompactCommunityLayout();
  const [authentication, setAuthentication] = useState<AuthenticationState>('checking');
  const [membership, setMembership] = useState<MembershipState>('checking');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const groups = useMemo(
    () => decodeGroupPagesFeed(props.scoped_group_pages, props.scoped_group_page_items, props.admitted_scope),
    [props],
  );
  const surfaces = useMemo(
    () => props.admitted_scope ? findSubjectSurfaces(props.scoped_subject_surfaces, props.admitted_scope).map((surface) => ({
      ...surface,
      surfaceInput: {
        ...(surface.surfaceInput ?? {}),
        admitted_scope: props.admitted_scope,
      },
    })) : [],
    [props],
  );
  const group = groups[0];
  const signInSurface = useMemo(() => readSignInSurface(props.sign_in_surface), [props.sign_in_surface]);
  const [items, setItems] = useState<GroupPageItem[]>(group?.items ?? []);
  const [collections, setCollections] = useState<SurfaceCollection[]>([]);
  useEffect(() => setItems(group?.items ?? []), [group?.groupRef]);
  useEffect(() => {
    let cancelled = false;
    let browserId = '';
    try {
      browserId = globalThis.localStorage?.getItem(BROWSER_ID_STORAGE_KEY)?.trim() ?? '';
    } catch {
      browserId = '';
    }
    if (!browserId) {
      setAuthentication('anonymous');
      return () => { cancelled = true; };
    }
    setAuthentication('checking');
    void sendRequestToBitfieldTarget({ target: SESSION_TARGET, payload: { browser_id: browserId } })
      .then((reply) => { if (!cancelled) setAuthentication(replyHasSignedInSession(reply) ? 'signed-in' : 'anonymous'); })
      .catch(() => { if (!cancelled) setAuthentication('anonymous'); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!group?.groupRef) {
      setCollections([]);
      return;
    }
    let cancelled = false;
    const scope = readCollectionScope(props.collection_scope, group.groupRef);
    void loadSurfaceCollectionsGraph(scope)
      .then((reply) => {
        if (cancelled) return;
        setCollections(readSurfaceCollections(reply));
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      });
    return () => { cancelled = true; };
  }, [group?.groupRef, props.collection_scope]);

  const walkthrough = useMemo(() => readFirstPostWalkthroughConfig(props.first_post_walkthrough), [props.first_post_walkthrough]);

  useEffect(() => {
    if (!group?.groupRef) {
      setMembership('checking');
      return;
    }
    if (authentication === 'checking') {
      setMembership('checking');
      return;
    }
    if (authentication !== 'signed-in') {
      setMembership('anonymous');
      return;
    }
    let cancelled = false;
    setMembership('joining');
    void ensureGroupMembership(group.groupRef)
      .then(() => {
        if (cancelled) return;
        setMembership('joined');
        if (walkthrough) {
          emitWalkthroughEvent({
            event_kind: walkthrough.readyEventKind,
            subject_ref: group.groupRef,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setMembership('error');
        setMessage('Your sign-in is real, but the community has not confirmed your membership yet. Try again.');
      });
    return () => { cancelled = true; };
  }, [authentication, group?.groupRef, walkthrough]);
  useEffect(() => {
    if (membership !== 'joined' || !group?.groupRef) return;
    let cancelled = false;
    void readGroupPosts(group.groupRef)
      .then((reply) => {
        if (!cancelled) setItems(mergeItems(group.items, readCreatedItems(reply)));
      })
      .catch(() => {
        if (!cancelled) setMessage((current) => current ?? 'New posts could not be refreshed yet. Existing posts are still available.');
      });
    return () => { cancelled = true; };
  }, [membership, group?.groupRef]);

  if (!group) {
    return (
      <Container as="section" height="full" alignItems="center" justifyContent="center" padding="xl">
        <Card variant="surface" padding="xl">
          <Text variant="heading-lg" color="strong">Community</Text>
          <Text variant="body" color="secondary">This community is not available right now.</Text>
        </Card>
      </Container>
    );
  }

  const openSignIn = () => {
    if (!signInSurface) {
      setMessage('Sign-in is not available right now. Nothing was submitted.');
      return;
    }
    setMessage(null);
    setSignInOpen(true);
  };

  const joinLabel = membership === 'joined'
    ? 'Joined'
    : membership === 'joining'
      ? 'Joining…'
      : authentication === 'checking'
        ? 'Checking sign-in…'
        : authentication === 'signed-in'
          ? 'Join community'
          : 'Sign in to join';

  const joined = membership === 'joined';
  const composerLocked = authentication !== 'signed-in' || membership === 'checking' || membership === 'joining';
  const collectionLookup = new Map(collections.map((collection) => [collection.id, collection]));
  const introductionsCollection = collections.find((collection) => /introduction/i.test(collection.name)) ?? null;
  const introductionSurface = introductionsCollection
    ? introductionsCollection.members
      .filter((member) => member.kind === 'surface')
      .map((member) => surfaces.find((surface) => surface.ref === member.surfaceId))
      .find((surface): surface is NonNullable<typeof surface> => Boolean(surface))
    : null;

  const confirmMembership = async (retryMessage?: string) => {
    if (membership === 'joined') return true;
    if (authentication !== 'signed-in') return false;
    setMembership('joining');
    setMessage(null);
    try {
      await ensureGroupMembership(group.groupRef);
      setMembership('joined');
      if (walkthrough) {
        emitWalkthroughEvent({
          event_kind: walkthrough.readyEventKind,
          subject_ref: group.groupRef,
        });
      }
      return true;
    } catch {
      setMembership('error');
      setMessage(retryMessage ?? 'The community could not confirm your membership yet. Try again.');
      return false;
    }
  };

  const submitPost = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    if (authentication !== 'signed-in') {
      openSignIn();
      return;
    }
    if (!(await confirmMembership('Your sign-in is real, but posting stays locked until the community confirms your membership. Try again.'))) {
      return;
    }
    setPosting(true);
    setMessage(null);
    try {
      const reply = await createGroupPost({
        idempotencyRef: `share:${crypto.randomUUID()}`,
        groupRef: group.groupRef,
        fields: { kind: 'post', body },
      });
      setItems((current) => [readCreatedItem(reply, body), ...current]);
      setDraft('');
      setMessage('Posted to the community.');
      if (walkthrough) {
        emitWalkthroughEvent({
          event_kind: walkthrough.completedEventKind,
          subject_ref: group.groupRef,
        });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
    } catch {
      setMessage('Your post was not saved. Nothing was lost—try again in a moment.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <Container
      as="section"
      data-package="group-page"
      layout="vertical"
      height="full"
      minHeight="0"
      overflow={compactLayout ? 'y-auto' : 'hidden'}
      gap="md"
      padding="lg"
    >
      <FloatingPanel
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        title="Sign in to join the conversation"
        width={480}
        description="We will email you a secure sign-in link. If you are new, the same link creates your free account."
      >
        {signInSurface ? (
          <PlaceableSurfaceHost
            packageName={signInSurface.packageName}
            entryName={signInSurface.entryName}
            materialTarget={signInSurface.materialTarget}
            target={signInSurface.target}
            surfaceInput={signInSurface.surfaceInput}
            interactive
          />
        ) : null}
      </FloatingPanel>
      <Card variant="surface" padding="lg">
        <Container layout="horizontal" gap="lg" alignItems="center" justifyContent="between" wrap>
          <Container layout="vertical" gap="sm" minWidth="0">
            <Badge variant="info" size="sm"><Users aria-hidden="true" size={14} /> Community</Badge>
            <Text variant="heading-xl" color="strong">{group.name}</Text>
            <Text variant="body" color="secondary">{group.summary}</Text>
          </Container>
          <Button
            data-guided-overlay-target="community-join-state"
            variant={joined ? 'secondary' : 'primary'}
            disabled={joined || membership === 'joining' || authentication === 'checking'}
            onClick={async () => {
              if (authentication !== 'signed-in') {
                openSignIn();
                return;
              }
              const joinedNow = await confirmMembership();
              if (joinedNow) setMessage('You are in the community now.');
            }}
          >
            {joinLabel}
          </Button>
        </Container>
      </Card>

      {collections.length > 0 ? (
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" alignItems="center" justifyContent="between">
            <Text variant="heading-md" color="strong">Start here</Text>
            <Text variant="body-sm" color="muted">{collections.length} {collections.length === 1 ? 'space' : 'spaces'}</Text>
          </Container>
          <Container layout="horizontal" gap="sm" wrap>
            {collections.map((collection) => {
              const leadSurface = collection.members
                .filter((member) => member.kind === 'surface')
                .map((member) => surfaces.find((surface) => surface.ref === member.surfaceId))
                .find((surface): surface is NonNullable<typeof surface> => Boolean(surface));
              const nestedCount = collection.members.filter((member) => member.kind === 'collection' && collectionLookup.has(member.surfaceId)).length;
              const isIntroductions = collection.id === introductionsCollection?.id;
              return (
                <Card
                  key={collection.id}
                  variant="nested"
                  padding="lg"
                  className="min-w-[16rem] flex-1"
                  data-guided-overlay-target={isIntroductions ? 'community-introductions' : undefined}
                >
                  <Container layout="vertical" gap="sm">
                    <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md">
                      <Text variant="heading" color="strong">{collection.name}</Text>
                      <Badge variant={isIntroductions ? 'success' : 'secondary'} size="sm">
                        {collection.members.length} {collection.members.length === 1 ? 'destination' : 'destinations'}
                      </Badge>
                    </Container>
                    <Text variant="body-sm" color="secondary">
                      {isIntroductions
                        ? 'Introduce yourself here first so other members know who just joined.'
                        : nestedCount > 0
                          ? 'Open the collection to see the spaces inside it.'
                          : 'Open this space to read or post in the right place.'}
                    </Text>
                    {leadSurface ? (
                      <Button type="button" variant={isIntroductions ? 'primary' : 'secondary'} onClick={() => openSurface(leadSurface)}>
                        {isIntroductions ? 'Open Introductions' : `Open ${collection.name}`}
                      </Button>
                    ) : null}
                  </Container>
                </Card>
              );
            })}
          </Container>
        </Container>
      ) : null}

      {surfaces.length > 0 ? (
        <Container as="nav" aria-label="Community tools" layout="horizontal" gap="sm" wrap>
          {surfaces.map((surface) => (
            <Button
              key={surface.ref}
              variant="secondary"
              size="sm"
              onClick={() => openSurface(surface)}
            >
              {surface.label}
            </Button>
          ))}
        </Container>
      ) : null}

      <Container
        layout={compactLayout ? 'vertical' : 'horizontal'}
        flex={compactLayout ? 'none' : 1}
        minHeight="0"
        gap="md"
        overflow={compactLayout ? 'visible' : 'hidden'}
      >
        <Card
          variant="surface"
          padding="lg"
          className="shrink-0"
          style={{ width: compactLayout ? '100%' : '22rem', alignSelf: compactLayout ? 'stretch' : 'flex-start' }}
        >
          <Container as="form" layout="vertical" gap="md" onSubmit={(event) => { event.preventDefault(); void submitPost(); }}>
            <Container layout="horizontal" gap="sm" alignItems="center">
              <MessageCircle aria-hidden="true" size={20} />
              <Text variant="heading-md" color="strong">Share with the community</Text>
            </Container>
            {authentication === 'signed-in' ? (
              <>
                {introductionsCollection ? (
                  <Card variant="nested" padding="md" data-guided-overlay-target="community-first-post-home">
                    <Container layout="vertical" gap="sm">
                      <Text variant="heading" color="strong">Your first post belongs in {introductionsCollection.name}</Text>
                      <Text variant="body-sm" color="secondary">
                        Start by introducing yourself so the community knows what you are building and why you are here.
                      </Text>
                      {introductionSurface ? (
                        <Button type="button" variant="secondary" onClick={() => openSurface(introductionSurface)}>
                          Open Introductions
                        </Button>
                      ) : null}
                    </Container>
                  </Card>
                ) : null}
                <label className="sr-only" htmlFor="community-post-draft">Write a post</label>
                <textarea
                  data-guided-overlay-target="community-first-post-composer"
                  id="community-post-draft"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={introductionsCollection ? 'Introduce yourself, share what you are building, and tell the community what you want help with…' : 'Ask a question, share a win, or post what you are building…'}
                  rows={7}
                  disabled={composerLocked}
                  className="w-full resize-none rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
                />
                {composerLocked ? (
                  <Text variant="body-sm" color="secondary">
                    {membership === 'joining'
                      ? 'Finishing your community membership so your first post has a real home…'
                      : membership === 'error'
                        ? 'Posting is paused until the community confirms your membership.'
                        : 'Checking your community membership…'}
                  </Text>
                ) : null}
                <Button
                  data-guided-overlay-target="community-first-post-submit"
                  type="submit"
                  variant="primary"
                  disabled={!draft.trim() || posting || composerLocked}
                >
                  <Send aria-hidden="true" size={16} /> {posting ? 'Posting…' : 'Post'}
                </Button>
              </>
            ) : (
              <Container layout="vertical" gap="sm" padding="md" border="all" rounded="lg">
                <Text variant="body" color="secondary">
                  {authentication === 'checking'
                    ? 'Checking whether you are signed in…'
                    : 'Sign in with your email to join conversations and publish posts.'}
                </Text>
                <Button type="button" variant="primary" disabled={authentication === 'checking'} onClick={openSignIn}>
                  {authentication === 'checking' ? 'Checking sign-in…' : 'Sign in to post'}
                </Button>
              </Container>
            )}
            {message ? <Text variant="body-sm" color="secondary" aria-live="polite">{message}</Text> : null}
          </Container>
        </Card>

        <Container
          layout="vertical"
          flex={1}
          minHeight="0"
          gap="sm"
          overflow="hidden"
          style={compactLayout ? { minHeight: '30rem', flex: '0 0 auto' } : undefined}
        >
          <Container layout="horizontal" alignItems="center" justifyContent="between">
            <Text variant="heading-md" color="strong">Latest posts</Text>
            <Text variant="body-sm" color="muted">{items.length} {items.length === 1 ? 'post' : 'posts'}</Text>
          </Container>
          <ScrollableSurface>
            <Container layout="vertical" gap="sm">
              {items.length ? items.map((item) => (
                <Card key={item.itemRef} variant="nested" padding="lg">
                  <Container layout="vertical" gap="sm">
                    <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md">
                      <Text variant="heading" color="strong">{item.authorRef || 'Community member'}</Text>
                      {item.createdAt ? <Text variant="body-sm" color="muted">{new Date(item.createdAt).toLocaleDateString()}</Text> : null}
                    </Container>
                    <Text variant="body" color="secondary" className="whitespace-pre-wrap">{item.text}</Text>
                  </Container>
                </Card>
              )) : (
                <Card variant="nested" padding="xl">
                  <Text variant="heading-md" color="strong">Start with Introductions</Text>
                  <Text variant="body" color="secondary">
                    {introductionsCollection
                      ? `Open ${introductionsCollection.name} and tell the community who you are and what you are building.`
                      : 'Ask a question or share what you are building.'}
                  </Text>
                </Card>
              )}
            </Container>
          </ScrollableSurface>
        </Container>
      </Container>
    </Container>
  );
}
