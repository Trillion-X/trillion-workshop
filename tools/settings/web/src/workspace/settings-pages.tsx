// src/workspace/settings-pages.tsx
//
// PURPOSE
//   The settings pages that are not another screen kept in place (settings-screen.tsx): the Menu bar page, which inside
//   the Mac app's panel (a host answers) draws the panel's own controls (panel-shortcut.tsx, panel-settings.tsx,
//   panel-setup.tsx) and anywhere else leads to that panel, and the What's new page, the dated
//   posts the build publishes from the product's what's-new tours (src/whats-new-rows.mjs, /workspace/whats-new.json),
//   newest first (F-0994, F-1000).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A page is chosen by its rail item's `panel` key (settings-panels.json); this file names no rail item.
//   2. Every word and limit is DATA (settings-pages.json). Every control is a shared part (parts/ui); this file writes no
//      markup of its own, and a post shows its words and picture, never an id.
//   3. A read that is still going, a read that failed and an empty list are three different pages; a failed read can be
//      tried again and is never drawn as nothing posted. At most `most_rows` posts are drawn.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Badge, Button, Card, Container, ImageBlock, Text } from '../../parts/ui';
import pages from './settings-pages.json';
import { ColourNamesPage } from './colour-names-page';
import { EmailSettingsPage } from './mail-settings';
import { KeymapSettings } from './keymap-settings';
import { dayOf, postsOf } from './settings-posts.mjs';
import { mountGuideScreen } from './guide-screens';
import { hostChannel, tellHost } from './host-channel';
import { PanelShortcut } from './panel-shortcut';
import { PanelSettings } from './panel-settings';
import { PanelSetup } from './panel-setup';
import { ChooseScreenLook } from '../../parts/screen-look/show/ChooseScreenLook';
import { PaneSizeSettings } from '../../parts/screen-arrangement/show/PaneSizeSettings';
import { CurrentFeelSettings } from './feel-settings';

type Post = { id: string; date: string; title: string; summary: string; points: string[]; picture: { src: string; alt: string } | null; open: string };

export function MenubarPage() {
  const words = pages.menubar;
  // Inside the menu bar panel the host answers, so its own controls are here (alone-page.tsx invariant 6); anywhere
  // else the page leads to the panel.
  if (hostChannel()) return (
    <Container layout="vertical" gap="sm" padding="md" data-settings-page="menubar">
      <PanelShortcut tell={tellHost} /><PanelSettings tell={tellHost} /><PanelSetup tell={tellHost} />
    </Container>
  );
  return (
    <Container layout="vertical" gap="md" padding="lg" data-settings-page="menubar">
      <Text as="h1" variant="heading-lg" className="page-title m-0">{words.title}</Text>
      <Text as="p" variant="body" color="secondary">{words.body}</Text>
      <Container layout="horizontal"><Button onClick={() => window.location.assign(words.address)}>{words.open}</Button></Container>
    </Container>
  );
}


export function WhatsNewPage() {
  const words = pages.whats_new;
  const [posts, setPosts] = React.useState<Post[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setFailed(false);
    fetch(words.rows_url, { headers: { accept: 'application/json' } })
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .then(answer => { const read = postsOf(answer) as Post[] | null; if (!live) return; if (read) setPosts(read); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt, words.rows_url]);
  return (
    <Container layout="vertical" gap="md" padding="lg" data-settings-page="whats-new">
      <Text as="h1" variant="heading-lg" className="page-title m-0">{words.title}</Text>
      {failed ? (
        <Container layout="vertical" gap="sm" data-whats-new-state="failed">
          <Text as="p" variant="body" color="secondary">{words.failed}</Text>
          <Container layout="horizontal"><Button variant="ghost" onClick={() => setAttempt(count => count + 1)}>{words.retry}</Button></Container>
        </Container>
      ) : !posts ? <Text as="p" variant="body" color="secondary" data-whats-new-state="loading">{words.loading}</Text>
        : posts.length === 0 ? <Text as="p" variant="body" color="secondary" data-whats-new-state="empty">{words.empty}</Text>
          : posts.map(post => (
            <Card key={post.id} variant="nested" padding="md" data-whats-new-post="">
              <Container layout="vertical" gap="sm">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Text as="h2" variant="heading" className="m-0">{post.title}</Text>
                  <Badge variant="muted">{dayOf(post.date)}</Badge>
                </Container>
                {post.summary ? <Text as="p" variant="body" color="secondary">{post.summary}</Text> : null}
                {post.picture ? <ImageBlock src={post.picture.src} alt={post.picture.alt} loading="lazy" maxHeight="20rem" /> : null}
                {post.points.map(point => <Text key={point} as="p" variant="body">{point}</Text>)}
                <Container layout="horizontal"><Button variant="ghost" size="sm" onClick={() => window.location.assign(post.open)}>{words.take_tour}</Button></Container>
              </Container>
            </Card>
          ))}
    </Container>
  );
}

// The Workspace page: the account's guide screen of that name (GET /work/api/screens/workspace, src/workspace-page.mjs), drawn
// by the one guide screen mount, so its reads, actions and failures are the guide's own.
export function WorkspacePage() {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => (host.current ? mountGuideScreen(host.current, { surfaceInput: { screen: 'workspace' } }) : undefined), []);
  return <div ref={host} className="h-full min-h-0 overflow-y-auto" data-settings-page="workspace" />;
}

// Look & feel: the parts a Look description placed by name, each keeping its own state from the person's records
// (settings-pages.json `look`). It reads no screen description, so it loads in every running Trillion.
const LOOK_PARTS: Record<string, () => React.ReactElement> = { 'screen-look': () => <ChooseScreenLook />, 'pane-sizes': () => <PaneSizeSettings />, feel: () => <CurrentFeelSettings /> };
export function LookPage() {
  return (
    <Container gap="lg" className="h-full min-h-0 overflow-y-auto p-4" data-settings-page="look">
      {pages.look.sections.map(section => {
        const Part = LOOK_PARTS[section.part];
        return Part ? <Container key={section.part} gap="sm" data-look-section={section.part}><Text variant="label" color="secondary">{section.heading}</Text><Part /></Container> : null;
      })}
    </Container>
  );
}

/** The panels a rail item can name. */
export const PAGES: Record<string, () => React.ReactElement> = { workspace: WorkspacePage, menubar: MenubarPage, 'whats-new': WhatsNewPage, 'colour-names': ColourNamesPage, email: EmailSettingsPage, keymap: KeymapSettings, look: LookPage };
