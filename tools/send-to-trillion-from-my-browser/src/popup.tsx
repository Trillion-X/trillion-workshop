// extension/src/popup.tsx
//
// PURPOSE
//   The Send to Trillion popup, in the order a person reads it:
//     On this page   the page as it describes itself (picture, site, title, description, copy link), and Save this
//                    chat on a chat site, which saves on its own.
//     Add to it      capture buttons: record audio, record this tab, the whole page, a video of the page
//                    (src/add-to-it.tsx).
//     Sending        everything that goes: the selection, the picture of the page, what was right-clicked on any page,
//                    and what the capture buttons made (a working row, then the kept file with its size).
//     File in        Trillion files it (the start), or one of the person's own lists, picked with one tap; then a note,
//                    right above Send.
//   A free account that asks for a paid thing sees the plans instead of an error (src/plan-offer.tsx).
//   Send writes the whole send as ONE record of the person's own through the one door (src/share-record.mjs), the
//   same record the iPhone Share sheet writes. A send the account cannot be reached for is kept on this device
//   (src/outbox.mjs) and sent again by the background worker.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Built from the shared parts (tools/ui); no control is hand-made here.
//   2. Every page is read the same way; nothing here knows a site or a list by name. The lists are the person's own
//      records.
//   3. "Sent" is shown only after the account answered the write; a refusal is said as it was said. "Kept" is shown
//      when the account kept the send at its edge (queued) or this device kept it to send again; either way the person
//      never has to send it again.
//   3a. One request_key is made per draft and kept with it (session `draft:<tab id>`); every try of that send uses it.
//   4. Words come from DATA (extension/words.json), never inline copy; the look is the one the person wears in
//      Trillion (extension/src/worn-look-page.ts; settings.json look until the account first answers).
//   5. What the person did here is kept per tab (session `draft:<tab id>`) and what the account said is kept once
//      (session `known`), so reopening the popup shows it at once, exactly as they left it; the account is asked
//      again quietly behind it. The page is read again only when the tab now shows a different address.
//   6. While the popup is still reading (longer than `COVER_AFTER_MS`), the Trillion opening cover covers it
//      (tools/ui/show/thread-cover), lifted the moment it has something to show.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { DisclosureSection } from 'trillion-workshop/tools/ui/show/disclosure-section/DisclosureSection.tsx';
import { formatBytes } from 'trillion-workshop/tools/ui/show/notifications/notification-center.ts';
import { ImageBlock } from 'trillion-workshop/tools/ui/show/image-block/ImageBlock.tsx';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from 'trillion-workshop/tools/ui/show/coss/ui/select.tsx';
import { Spinner } from 'trillion-workshop/tools/ui/show/spinner/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { Textarea } from 'trillion-workshop/tools/ui/show/input/index.ts';
import { LinkPreview } from 'trillion-workshop/tools/ui/show/link-preview/index.ts';
import { CopyButton } from 'trillion-workshop/tools/ui/show/copy-button/CopyButton.tsx';
import { keepFile, ORIGIN, sentFileName, SignInNeeded, signedIn, signedInAccount, signOut, startSignIn, tool } from './trillion.mjs';
import { readLists, writeArguments } from './share-record.mjs';
import { sendOrKeep, waiting } from './outbox.mjs';
import { removeFromTray, visibleToAccount } from './tray.mjs';
import { AddToIt } from './add-to-it.tsx';
import { PlanOffer, type PlanNeededNote } from './plan-offer.tsx';
import { mountThreadCover } from 'trillion-workshop/tools/ui/show/thread-cover/thread-cover.mjs';
import { type Recording } from './recording-row.tsx';
import { SaveThisChat } from './save-chat.tsx';
import { paintWithWornLook } from './worn-look-page';
import pageTools from '../page-tools.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };
import settings from '../settings.json' with { type: 'json' };
import mountFeel from 'trillion-workshop/tools/feel/show/mount-feel.ts';
import {currentExtensionFeel} from './current-feel.mjs';

type Item = { kind: string; url?: string | null; title?: string | null; text?: string | null; image?: string | null; page_url?: string | null; page_title?: string | null; file?: string; name?: string; pictures?: string[]; size?: number | null; made_by?: string; account?: string };
type ShareList = { id: string; label: string; row_type: string; title_field: string | null };
type PageRead = { url: string; title: string | null; description: string | null; image: string | null; site: string | null; icon: string | null; selection: string | null };
type Found = { page: Item | null; read: PageRead | null; selection: Item | null; picture: string | null; picture_marked?: boolean; tabTitle: string; tabId: number | null };
type Run = { id: string; row_id: string; account: string; page: { url: string; title: string | null }; state: 'working' | 'later' | 'failed'; said?: string };
// What the person did on this tab, kept for when the popup opens again.
type Draft = { found: Found; keepPage: boolean; keepSelection: boolean; keepPicture: boolean; list: string | null; ownWords: string; requestKey?: string };
// What the account said, kept once for every tab.
type Known = { lists: ShareList[] };
async function readKnown(account: string | null): Promise<Known | undefined> {
  if (!account) return undefined;
  const key = `known:${account}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] as Known | undefined;
}

// Runs inside the page: what any page says about itself.
function readPage(): PageRead {
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || null;
  const absolute = (value: string | null | undefined) => { try { return value ? new URL(value, location.href).href : null; } catch { return null; } };
  const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]')];
  const largest = icons.sort((a, b) => (parseInt(b.sizes?.[0] ?? '0', 10) || 0) - (parseInt(a.sizes?.[0] ?? '0', 10) || 0))[0];
  return {
    url: location.href, title: meta('og:title') ?? meta('twitter:title') ?? (document.title || null),
    description: meta('og:description') ?? meta('twitter:description') ?? meta('description'),
    image: absolute(meta('og:image') ?? meta('og:image:url') ?? meta('twitter:image')), site: meta('og:site_name'),
    icon: absolute(largest?.getAttribute('href')) ?? `${location.origin}/favicon.ico`,
    selection: String(getSelection() ?? '').trim() || null,
  };
}

// Opened in its own window, the popup was handed the tab it was opened from (?tab=); otherwise it is that window's tab.
const openedFrom = Number(new URLSearchParams(location.search).get('tab')) || null;
const inItsOwnWindow = openedFrom !== null;
const thisTab = async () => (openedFrom ? chrome.tabs.get(openedFrom) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);

async function findOnThisPage(tab: chrome.tabs.Tab): Promise<Found> {
  let read: PageRead | null = null;
  try { read = (await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: readPage }))[0]?.result ?? null; } catch {}
  let picture: string | null = null;
  try { picture = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 }); } catch {}
  const url = read?.url ?? tab.url ?? null;
  // Some browser-owned pages cannot be inspected, but the tab can still provide an address and title to send as a link.
  const page: Item | null = url ? { kind: 'page', url, title: read?.title ?? tab.title ?? null, text: read?.description ?? null, image: read?.image ?? null } : null;
  const icon = read?.icon ?? tab.favIconUrl ?? null;
  return { page, read: read ? { ...read, icon } : url ? { url, title: page?.title ?? null, description: null, image: null, site: null, icon, selection: null } : null,
    selection: read?.selection ? { kind: 'selection', url, text: read.selection } : null, picture, tabTitle: page?.title ?? '', tabId: tab.id ?? null };
}

// Mark up opens the picture in its own window (src/markup.tsx), as large as the screen allows; the window puts the
// marked picture back in this tab's draft and opens this popup again.
async function markUp(tabId: number | null) {
  if (tabId === null) return;
  await chrome.windows.create({ url: chrome.runtime.getURL(`markup.html?tab=${tabId}`), type: 'popup', width: Math.min(1280, screen.availWidth), height: Math.min(900, screen.availHeight) });
  window.close();
}

const bytesOfDataUrl = (address: string) => Uint8Array.from(atob(address.split(',')[1]), character => character.charCodeAt(0));
const siteOf = (url?: string | null) => { try { return new URL(url ?? '').hostname.replace(/^www\./, ''); } catch { return ''; } };
// The row of extension/page-tools.json that made a tray item, from either list.
const madeBy = (id?: string) => [...pageTools.tools, ...pageTools.recordings, pageTools.files].find(row => row.id === id) ?? null;
const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');

function ItemRow({ icon, title, detail, picture, working, failed, onRemove, onMarkUp }: { icon: string; title: string; detail?: string | null; picture?: string | null; working?: boolean; failed?: boolean; onRemove?: () => void; onMarkUp?: () => void }) {
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" rounded="lg" border="all" width="full" aria-busy={working || undefined}>
      {picture ? <ImageBlock src={picture} alt="" rounded="md" objectFit="cover" className="h-9 w-12 shrink-0" /> : <NamedIcon name={icon} size="sm" aria-hidden="true" />}
      <Container layout="vertical" gap="none" className="min-w-0 flex-1">
        <Text variant="body-xs" weight="medium" truncate>{title}</Text>
        {detail ? <Text variant="caption" color={failed ? 'error' : 'muted'} className={failed ? 'whitespace-normal' : undefined} truncate={!failed}>{detail}</Text> : null}
      </Container>
      {working ? <Spinner size="sm" /> : null}
      {onMarkUp ? <Button variant="ghost" size="icon" aria-label={words.mark_up} title={words.mark_up} onClick={onMarkUp}><NamedIcon name="PenLine" size="sm" aria-hidden="true" /></Button> : null}
      {onRemove ? <Button variant="ghost" size="icon" aria-label={words.remove} onClick={onRemove}><NamedIcon name="X" size="sm" aria-hidden="true" /></Button> : null}
    </Container>
  );
}

function Header({ onSignOut }: { onSignOut?: () => void }) {
  return (
    <Container layout="horizontal" alignItems="center" justifyContent="between" width="full">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <ImageBlock src="icons/icon-32.png" alt="" rounded="md" className="h-6 w-6" />
        <Text variant="heading-xs">{words.title}</Text>
      </Container>
      {onSignOut ? (
        <Container layout="horizontal" gap="xs" alignItems="center">
          {inItsOwnWindow ? null : (
            <Button variant="ghost" size="icon" aria-label={words.open_in_window} title={words.open_in_window} onClick={async () => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?tab=${tab.id}`), type: 'popup', width: 440, height: 820 });
              window.close();
            }}><NamedIcon name="Maximize2" size="sm" aria-hidden="true" /></Button>
          )}
          <Button variant="ghost" size="xs" onClick={onSignOut}>{words.sign_out}</Button>
        </Container>
      ) : null}
    </Container>
  );
}

type Choice = { value: string; label: string };
/** One choice from a list, picked with one tap. */
function PickOne({ label, value, items, onChange }: { label: string; value: string; items: Choice[]; onChange: (value: string) => void }) {
  return (
    <Select value={value} items={items} onValueChange={next => onChange(String(next ?? ''))}>
      <SelectTrigger aria-label={label} size="lg" className="w-full"><SelectValue /></SelectTrigger>
      <SelectPopup portalProps={{ className: 'coss-ui' }} alignItemWithTrigger={false}>
        {items.map(item => <SelectItem key={item.value || 'none'} value={item.value}>{item.label}</SelectItem>)}
      </SelectPopup>
    </Select>
  );
}

/** How long the popup reads before the opening cover shows; a quicker read shows no cover. */
const COVER_AFTER_MS = 150;

function Popup() {
  const [phase, setPhase] = React.useState<'loading' | 'signed-out' | 'ready' | 'sending' | 'sent' | 'kept'>('loading');
  const [found, setFound] = React.useState<Found | null>(null);
  const [keepPage, setKeepPage] = React.useState(true);
  const [keepSelection, setKeepSelection] = React.useState(true);
  const [keepPicture, setKeepPicture] = React.useState(true);
  const [tray, setTray] = React.useState<Item[]>([]);
  const [runs, setRuns] = React.useState<Run[]>([]);
  const [currentAccount, setCurrentAccount] = React.useState<string | null>(null);
  const currentAccountRef = React.useRef<string | null>(null);
  const accountEpoch = React.useRef(0);
  const [recording, setRecording] = React.useState<Recording | null>(null);
  const [planNeeded, setPlanNeeded] = React.useState<PlanNeededNote | null>(null);
  const [lists, setLists] = React.useState<ShareList[]>([]);
  // No list is picked at the start: Trillion files the share itself.
  const [list, setList] = React.useState<string | null>(null);
  const [ownWords, setOwnWords] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [firstRun, setFirstRun] = React.useState(false);
  const [requestKey, setRequestKey] = React.useState(() => crypto.randomUUID());
  const [keptWhere, setKeptWhere] = React.useState<'account' | 'device'>('device');
  const [waitingCount, setWaitingCount] = React.useState(0);
  const [olderShareCount, setOlderShareCount] = React.useState(0);
  const [tabInfo, setTabInfo] = React.useState<{ id: number; title: string | null; url: string } | null>(null);

  // The opening cover, only when reading takes long enough to be seen (invariant 6).
  const loading = phase === 'loading';
  React.useEffect(() => {
    if (!loading) return;
    let cover: { lift(): Promise<void> } | null = null;
    const shown = setTimeout(() => { cover = mountThreadCover(document); }, COVER_AFTER_MS);
    return () => { clearTimeout(shown); void cover?.lift(); };
  }, [loading]);

  // What the account says: shown from what was kept at once, then asked again quietly and kept.
  const readAccount = React.useCallback(async (account: string, epoch: number) => {
    const read: ShareList[] = await readLists((name: string, args: Record<string, unknown>) => tool(name, args, account));
    if (epoch !== accountEpoch.current || currentAccountRef.current !== account) return;
    setLists(read);
    await chrome.storage.session.set({ [`known:${account}`]: { lists: read } satisfies Known });
  }, []);

  React.useEffect(() => {
    const epoch = accountEpoch.current;
    (async () => {
      const tab = await thisTab();
      if (epoch !== accountEpoch.current) return;
      if (tab?.id !== undefined && tab.url) setTabInfo({ id: tab.id, title: tab.title ?? null, url: tab.url });
      const key = `draft:${tab?.id}`;
      const stored = await chrome.storage.session.get([key, 'tray', 'page_runs', 'recording', 'plan_needed']);
      const account = await signedInAccount();
      if (epoch !== accountEpoch.current) return;
      currentAccountRef.current = account;
      setCurrentAccount(account);
      const known = await readKnown(account);
      if (epoch !== accountEpoch.current || currentAccountRef.current !== account) return;
      setTray((stored.tray ?? []).filter((item: Item) => visibleToAccount(item, account)));
      setRuns((stored.page_runs ?? []).filter((run: Run) => run.account === account));
      setRecording(stored.recording ?? null); setPlanNeeded(stored.plan_needed ?? null);
      setFirstRun(!(await chrome.storage.local.get('sent_once')).sent_once);
      const draft = stored[key] as Draft | undefined;
      const samePage = Boolean(draft && draft.found.page?.url === tab?.url);
      if (!(await signedIn())) {
        if (epoch !== accountEpoch.current) return;
        setFound(samePage ? draft!.found : await findOnThisPage(tab));
        setPhase('signed-out');
        return;
      }
      if (!account) {
        const pageFound = samePage ? draft!.found : await findOnThisPage(tab);
        if (epoch !== accountEpoch.current) return;
        setFound(pageFound);
        setProblem('I could not confirm the signed-in account. Close and reopen Send to Trillion to try again.');
        setPhase('ready');
        return;
      }
      if (samePage && known) {
        // Exactly as they left it; the account is asked again behind it.
        setFound(draft!.found); setKeepPage(draft!.keepPage); setKeepSelection(draft!.keepSelection); setKeepPicture(draft!.keepPicture);
        setList(draft!.list ?? null); setOwnWords(draft!.ownWords); if (draft!.requestKey) setRequestKey(draft!.requestKey);
        setLists(known.lists ?? []);
        setPhase('ready');
        readAccount(account, epoch).catch(error => {
          if (epoch === accountEpoch.current && error instanceof SignInNeeded) setPhase('signed-out');
        });
        return;
      }
      const pageFound = await findOnThisPage(tab);
      setFound(pageFound);
      try {
        await readAccount(account, epoch);
        if (epoch !== accountEpoch.current || currentAccountRef.current !== account) return;
        setPhase('ready');
      } catch (error) {
        if (epoch !== accountEpoch.current || currentAccountRef.current !== account) return;
        if (error instanceof SignInNeeded) { setPhase('signed-out'); return; }
        setProblem(String((error as Error).message));
        setPhase('ready');
      }
    })();
  }, [readAccount]);

  // Sends kept on this device, said quietly while they wait.
  React.useEffect(() => {
    const count = () => waiting().then(rows => {
      const account = currentAccountRef.current;
      if (!account) { setWaitingCount(0); setOlderShareCount(0); return; }
      setWaitingCount(rows.filter(row => row.account === account && !row.refused && !row.migration_required).length);
      setOlderShareCount(rows.filter(row => row.account === account && row.migration_required).length);
    }).catch(() => {});
    count();
    const heard = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes.outbox) count(); };
    chrome.storage.onChanged.addListener(heard);
    return () => chrome.storage.onChanged.removeListener(heard);
  }, [phase]);

  // What was right-clicked, made or recorded while this is open shows here at once.
  React.useEffect(() => {
    const heard = (changes: Record<string, chrome.storage.StorageChange>) => {
      const account = currentAccountRef.current;
      if (changes.tray) setTray((changes.tray.newValue ?? []).filter((item: Item) => visibleToAccount(item, account)));
      if (changes.page_runs) setRuns((changes.page_runs.newValue ?? []).filter((run: Run) => run.account === account));
      if (changes.recording) setRecording(changes.recording.newValue ?? null);
      if (changes.plan_needed) setPlanNeeded(changes.plan_needed.newValue ?? null);
    };
    chrome.storage.session.onChanged.addListener(heard);
    return () => chrome.storage.session.onChanged.removeListener(heard);
  }, []);

  React.useEffect(() => {
    const accountChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.tokens) return;
      const epoch = ++accountEpoch.current;
      currentAccountRef.current = null;
      setCurrentAccount(null); setTray([]); setRuns([]);
      setLists([]); setList(null);
      setProblem(null); setPhase('loading');
      void signedInAccount().then(async account => {
        if (epoch !== accountEpoch.current) return;
        currentAccountRef.current = account;
        setCurrentAccount(account);
        const [stored, known] = await Promise.all([
          chrome.storage.session.get(['tray', 'page_runs']),
          readKnown(account),
        ]);
        if (epoch !== accountEpoch.current || currentAccountRef.current !== account) return;
        setTray((stored.tray ?? []).filter((item: Item) => visibleToAccount(item, account)));
        setRuns((stored.page_runs ?? []).filter((run: Run) => run.account === account));
        if (!account) { setPhase('signed-out'); return; }
        if (known) {
          setLists(known.lists ?? []);
          setPhase('ready');
        } else {
          await readAccount(account, epoch);
          if (epoch === accountEpoch.current && currentAccountRef.current === account) setPhase('ready');
        }
      }).catch(error => {
        if (epoch !== accountEpoch.current) return;
        setProblem(String((error as Error).message));
        setPhase(currentAccountRef.current ? 'ready' : 'signed-out');
      });
    };
    chrome.storage.onChanged.addListener(accountChanged);
    return () => chrome.storage.onChanged.removeListener(accountChanged);
  }, [readAccount]);

  // A finished or failed recording is said once, then forgotten.
  React.useEffect(() => {
    if (recording?.state === 'failed') setProblem(`${pageTools.recording.failed} ${recording.problem ?? ''}`.trim());
    if (recording?.state === 'kept' || recording?.state === 'failed') chrome.storage.session.remove('recording');
  }, [recording]);

  // Everything the person did here is kept for this tab as they do it.
  React.useEffect(() => {
    if (phase !== 'ready' || !found || found.tabId === null) return;
    chrome.storage.session.set({ [`draft:${found.tabId}`]: { found, keepPage, keepSelection, keepPicture, list, ownWords, requestKey } satisfies Draft });
  }, [phase, found, keepPage, keepSelection, keepPicture, list, ownWords, requestKey]);

  const items: Item[] = [
    ...(found?.page && keepPage ? [found.page] : []),
    ...(found?.selection && keepSelection ? [found.selection] : []),
    ...tray,
  ];
  const nothingToSend = !items.length && !(found?.picture && keepPicture);
  // A list counts only while the person still keeps it; otherwise Trillion files the share.
  const chosenList = lists.find(item => item.id === list) ?? null;

  async function send() {
    const epoch = accountEpoch.current;
    const expectedAccount = currentAccountRef.current;
    setPhase('sending'); setProblem(null);
    try {
      const account = await signedInAccount();
      if (!expectedAccount || account !== expectedAccount || epoch !== accountEpoch.current || currentAccountRef.current !== expectedAccount) throw new SignInNeeded();
      const sent: Item[] = items.filter(item => visibleToAccount(item, account));
      if (found?.picture && keepPicture) {
        const name = sentFileName(found.tabTitle, 'jpg');
        sent.push({ kind: 'picture', url: found.page?.url ?? null, name, file: await keepFile({ bytes: bytesOfDataUrl(found.picture), name, mediaType: 'image/jpeg', expectedAccount }) });
      }
      if (epoch !== accountEpoch.current || currentAccountRef.current !== expectedAccount) throw new SignInNeeded();
      const args = writeArguments({ requestKey, items: sent, ownWords, from: settings.shared_from, at: new Date().toISOString(), list: chosenList });
      const accountTool = (name: string, input: Record<string, unknown>) => tool(name, input, account);
      const { state, where } = await sendOrKeep({ tool: accountTool, args, account });
      if (epoch !== accountEpoch.current || currentAccountRef.current !== expectedAccount) return;
      if (state === 'kept') {
        const nextTray = await removeFromTray(sent, account);
        if (epoch !== accountEpoch.current || currentAccountRef.current !== expectedAccount) return;
        setTray(nextTray.filter((item: Item) => visibleToAccount(item, expectedAccount)));
        await chrome.storage.session.remove(`draft:${found?.tabId}`);
        setKeptWhere(where as 'account' | 'device'); setRequestKey(crypto.randomUUID());
        setPhase('kept');
        return;
      }
      const nextTray = await removeFromTray(sent, account);
      if (epoch !== accountEpoch.current || currentAccountRef.current !== expectedAccount) return;
      setTray(nextTray.filter((item: Item) => visibleToAccount(item, expectedAccount)));
      await chrome.storage.session.remove(`draft:${found?.tabId}`);
      await chrome.storage.local.set({ sent_once: true });
      setRequestKey(crypto.randomUUID());
      setPhase('sent');
    } catch (error) {
      if (epoch !== accountEpoch.current || currentAccountRef.current !== expectedAccount) return;
      if (error instanceof SignInNeeded) { setPhase('signed-out'); return; }
      setPhase('ready');
      setProblem(`${words.could_not_send} ${(error as Error).message}`);
    }
  }

  const signOutNow = async () => { await signOut({ end: true }); setPhase('signed-out'); };

  if (phase === 'loading') return (
    <Container layout="vertical" gap="md" padding="lg" width="full">
      <Header />
      <Text variant="caption" color="muted">{words.looking}</Text>
    </Container>
  );

  if (phase === 'signed-out') return (
    <Container layout="vertical" gap="lg" padding="lg" width="full">
      <Header />
      {found?.read ? <LinkPreview url={found.read.url} title={found.read.title || words.this_page} site={found.read.site || siteOf(found.read.url)} icon={found.read.icon} picture={found.read.image} description={found.read.description} /> : null}
      <Text variant="body" color="muted">{words.signed_out}</Text>
      <Button variant="primary" size="lg" fullWidth onClick={async () => { try { await startSignIn(); window.close(); } catch (error) { setProblem((error as Error).message); } }}>{words.sign_in}</Button>
      {problem ? <Text variant="caption" color="error">{problem}</Text> : null}
    </Container>
  );

  if (phase === 'sent') return (
    <Container layout="vertical" gap="md" padding="xl" alignItems="center" width="full">
      <Container layout="horizontal" alignItems="center" justifyContent="center" className="h-14 w-14 rounded-full [corner-shape:round] bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]">
        <NamedIcon name="Check" size="xl" aria-hidden="true" />
      </Container>
      <Text variant="title" align="center">{chosenList ? words.added_to.replace('{list}', chosenList.label) : words.on_it}</Text>
      <Text variant="body" color="muted" align="center">{chosenList ? words.added_detail : words.files_itself}</Text>
      <Button variant="secondary" size="md" onClick={() => window.close()}>{words.done}</Button>
    </Container>
  );

  if (phase === 'kept') return (
    <Container layout="vertical" gap="md" padding="xl" alignItems="center" width="full">
      <Container layout="horizontal" alignItems="center" justifyContent="center" className="h-14 w-14 rounded-full [corner-shape:round] bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]">
        <NamedIcon name="Check" size="xl" aria-hidden="true" />
      </Container>
      <Text variant="title" align="center">{words.kept}</Text>
      <Text variant="body" color="muted" align="center">{keptWhere === 'account' ? words.kept_detail : words.kept_on_device}</Text>
      <Button variant="secondary" size="md" onClick={() => window.close()}>{words.done}</Button>
    </Container>
  );

  const read = found?.read;
  // With no list picked the button is the extension's own name (Send to ...).
  const sendLabel = chosenList ? words.add_to_list.replace('{list}', chosenList.label) : words.title;
  const pageRuns = runs.filter(run => run.page.url === found?.page?.url || run.state !== 'working');
  const removeVisibleFromTray = async (index: number) => {
    const item = tray[index];
    if (!item) return;
    const account = currentAccountRef.current;
    const epoch = accountEpoch.current;
    const nextTray = await removeFromTray(item, account);
    if (epoch !== accountEpoch.current || currentAccountRef.current !== account) return;
    setTray(nextTray.filter((kept: Item) => visibleToAccount(kept, account)));
  };
  const sections = words.sections;

  return (
    <Container layout="vertical" gap="md" padding="lg" width="full">
      <Header onSignOut={signOutNow} />

      {firstRun ? <Text variant="caption" color="muted">{words.first_run.replace('{site}', siteOf(found?.page?.url) || words.here)}</Text> : null}

      {planNeeded ? <PlanOffer needed={planNeeded} page={found?.page?.url ?? null} /> : null}

      <DisclosureSection title={sections.on_this_page} divider={false}>
        <Container layout="vertical" gap="sm" width="full">
          {read && found?.page && keepPage ? (
            <LinkPreview url={read.url} title={read.title || words.this_page} site={read.site || siteOf(read.url)} icon={read.icon} picture={read.image} description={read.description}
              actions={<>
                <CopyButton text={read.url} label={words.copy_link} copiedLabel={words.copied} failedLabel={words.copy_failed} />
                <Button variant="ghost" size="icon" aria-label={words.remove} onClick={() => setKeepPage(false)}><NamedIcon name="X" size="sm" aria-hidden="true" /></Button>
              </>} />
          ) : found?.page ? (
            <Button variant="ghost" size="xs" onClick={() => setKeepPage(true)}>{words.send_this_page_too}</Button>
          ) : null}
          <SaveThisChat tabId={found?.tabId ?? null} url={found?.page?.url} onSignInNeeded={() => setPhase('signed-out')} />
        </Container>
      </DisclosureSection>

      <DisclosureSection title={sections.add_to_it}>
        <AddToIt tab={tabInfo} page={found?.page?.url ? { url: found.page.url, title: found.page.title } : null} recording={recording}
          working={pageRuns.filter(run => run.state === 'working' && run.page.url === found?.page?.url).map(run => run.row_id)} onProblem={setProblem} />
      </DisclosureSection>

      <DisclosureSection title={sections.sending}>
        <Container layout="vertical" gap="xs" width="full">
          {found?.selection && keepSelection ? <ItemRow icon="TextQuote" title={found.selection.text!} detail={words.selected_text} onRemove={() => setKeepSelection(false)} /> : null}
          {found?.picture && keepPicture ? <ItemRow icon="Image" title={words.picture_of_page} detail={found.picture_marked ? words.picture_marked : words.picture_detail} picture={found.picture} onRemove={() => setKeepPicture(false)} onMarkUp={() => markUp(found.tabId)} /> : null}
          {tray.map((item, index) => {
            const row = madeBy(item.made_by);
            const size = typeof item.size === 'number' ? formatBytes(item.size) : null;
            const detail = row ? joined(row.kept_detail, size) : joined(`${item.kind === 'post' ? words.posted_on : words.added_from} ${siteOf(item.url) || siteOf(item.page_url)}`, size);
            return (
              <ItemRow key={`${item.kind}-${item.url}-${item.file ?? ''}-${index}`} icon={(words.icons_by_kind as Record<string, string>)[item.kind] ?? words.icon_otherwise}
                picture={item.pictures?.[0] ?? null} title={item.text || item.title || item.url || item.kind} detail={detail} onRemove={() => removeVisibleFromTray(index)} />
            );
          })}
          {pageRuns.map(run => {
            const row = madeBy(run.row_id);
            const said = run.state === 'working' ? row?.working : run.state === 'later' ? row?.later : `${pageTools.could_not} ${run.said ?? ''}`;
            return (
              <ItemRow key={run.id} icon={row?.icon ?? words.icon_otherwise} title={run.page.title || run.page.url} detail={said} working={run.state === 'working'} failed={run.state === 'failed'}
                onRemove={run.state === 'working' ? undefined : () => chrome.runtime.sendMessage({ page_run: { dismiss: { id: run.id } } })} />
            );
          })}
          {nothingToSend && !pageRuns.length ? <Text variant="caption" color="muted">{words.nothing_attached}</Text> : null}
          {pageRuns.some(run => run.state === 'later') ? (
            <Button variant="ghost" size="xs" onClick={() => chrome.tabs.create({ url: `${ORIGIN}${pageTools.files_path}` })}>{pageTools.open_files}</Button>
          ) : null}
        </Container>
      </DisclosureSection>

      <DisclosureSection title={sections.file_in}>
        <Container layout="vertical" gap="sm" width="full">
          {lists.length ? <PickOne label={sections.file_in} value={chosenList?.id ?? ''} items={[{ value: '', label: words.files_it }, ...lists.map(item => ({ value: item.id, label: item.label }))]}
            onChange={next => setList(next || null)} /> : null}
          {chosenList ? null : <Text variant="caption" color="muted">{words.files_itself}</Text>}
          <Textarea aria-label={words.own_words} placeholder={words.own_words} value={ownWords} rows={2} autoGrow maxHeight={140} onChange={event => setOwnWords(event.target.value)} />
        </Container>
      </DisclosureSection>

      <Container layout="vertical" gap="sm" width="full" position="sticky" inset="auto 0 0 0" className="bg-[var(--bg-primary)] pb-1 pt-2">
        {problem ? (
          <Container layout="horizontal" gap="sm" alignItems="start" padding="sm" rounded="lg" border="all" width="full">
            <NamedIcon name="CircleAlert" size="sm" color="error" aria-hidden="true" />
            <Text variant="caption" color="error" className="flex-1">{problem}</Text>
          </Container>
        ) : null}
        {waitingCount ? <Text variant="caption" color="muted">{words.waiting_to_send.replace('{count}', String(waitingCount))}</Text> : null}
        {olderShareCount ? <Text variant="caption" color="error">{words.older_shares_need_attention}</Text> : null}
        <Button variant="primary" size="lg" fullWidth loading={phase === 'sending'} disabled={nothingToSend} onClick={send}>
          {phase === 'sending' ? words.sending : sendLabel}
        </Button>
      </Container>
    </Container>
  );
}

// The look the person wears in Trillion (extension/src/worn-look-page.ts).
paintWithWornLook();
document.body.classList.add('coss-ui');
if (inItsOwnWindow) document.body.classList.add('send-to-trillion-window');
const host = document.body.appendChild(document.createElement('main'));
// What happens here feels the way it does in Trillion: the same rows and players (tools/feel), sound and motion in
// this window (a Chrome window has no touch to play).
const stopFeel=mountFeel({props:currentExtensionFeel()});
window.addEventListener('pagehide',stopFeel,{once:true});
createRoot(host).render(<Popup />);
