// A link to one file, made through share_file and drawn in the shared sharing sheet's link form: the sheet shows the link
// once, with a Copy button; the words and the link's length come from files-words.json and files-routes.json.
import React, { useState } from 'react';
import { Button, Container, Text } from '../../../../ui';
import { SharingSheet } from '../../../../ui/show/sharing-sheet/SharingSheet';
import { notify } from '../../../../ui/show/coss/notifications';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { mountSharedContent } from '../../../../ui/show/coss/shared-content';
import { openWorkPanel } from '../../../../screen-arrangement/show/mount-floating-panel';
import { files } from './api';
import { makeFileLink } from './file-link.mjs';
import words from './files-words.json';
import routes from './files-routes.json';

type Link = { url: string; expires_at: string | null };

function FileLinkSheet({ identity, name }: { identity: string; name: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [failed, setFailed] = useState(false);
  const make = () => {
    setFailed(false);
    makeFileLink(files.change, { identity, seconds: routes.link.seconds }).then(setLink, () => setFailed(true));
  };
  const copy = () => {
    if (!link) return;
    copyTextToClipboard(link.url).then(
      copied => notify(copied ? words.link.copied : words.link.copy_failed, { kind: copied ? 'done' : 'error' }),
      () => notify(words.link.copy_failed, { kind: 'error' }),
    );
  };
  const until = link?.expires_at ? new Date(link.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  return <Container layout="vertical" gap="sm" padding="sm">
    <SharingSheet
      preview={{ title: name }}
      places={[]}
      words={{ preview: words.link.preview, places: words.link.places, failed: words.link.failed }}
      access={link ? [{ id: 'link', label: words.link.label, detail: link.url, badge: words.link.once }] : []}
      actions={link
        ? [{ id: 'copy', label: words.link.copy, primary: true, run: copy }]
        : [{ id: 'make', label: words.link.make, primary: true, run: make }]}
    />
    {until ? <Text variant="body" color="subtle" role="status">{words.link.until.replace('{until}', until)}</Text> : null}
    {failed ? <Container layout="horizontal" gap="sm" alignItems="center"><Text variant="body" role="alert">{words.link.failed}</Text><Button variant="outline" size="sm" onClick={make}>{words.retry}</Button></Container> : null}
  </Container>;
}

/** Opens the link form for one file beside the page. */
export function openFileLink(identity: string, name: string, anchor?: Element | null) {
  if (!routes.link.shown) return;
  const panel = openWorkPanel(`${words.link.panel_title} ${name}`, { anchor, kind: 'file-link' });
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  if (body) mountSharedContent(body, <FileLinkSheet identity={identity} name={name} />);
}
