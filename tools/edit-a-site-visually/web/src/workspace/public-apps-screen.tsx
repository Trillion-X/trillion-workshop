// Edit an installed public app and read its own visitor activity.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Container, Input, SegmentedControl, Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea } from '../../parts/ui';
import appNames from '../public-app-names.json';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { LoadingMark } from '../../../../ui/show/loading-mark/index.ts';
import { ErrorBoundary } from '../../parts/ui/show/error-boundary';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { planNeededTitle, refusal } from './failure';
import { FolderPicker } from '../../parts/ui/show/folder-picker/FolderPicker';
import { VersionHistory } from '../../parts/ui/show/version-history';
import type { CanvasPeer, EditorReference, VisualHtmlEditorHandle } from '../../parts/ui/show/public-app-editor/VisualHtmlEditor';
import { LazyVisualHtmlEditor as VisualHtmlEditor } from '../../parts/ui/show/public-app-editor/LazyVisualHtmlEditor';
import { PublicCardOptions, type PublicCardPresentation } from '../../parts/ui/show/public-app-editor/PublicCardOptions';
import { openPresenceRoom, type PresenceChannel } from '../../parts/group/show/presence-channel';
import { activeParticipants, colorForParticipant, pruneStale, upsertPresence, EMPTY_PRESENCE, type PresenceState } from '../../parts/group/read-data/presence';
import type { VisualSelectionRef } from '../../parts/ui/show/public-app-editor/selection-ref';
import { applyGrapesJsExport, checkedPublicAppEditorSource, cssLinks, grapesJsImportModel, publicAppEditorImageAssets, publicAppEditorRoutePages } from '../../../src/public-app-editor-model.mjs';
import { publicAppActionVersion } from '../../../src/public-app-capabilities.mjs';
import { publicAppActionLibraryCopy } from './public-app-library-copy.mjs';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { appProjectFromImportedSite, appProjectFromPinnedRepository } from '../app-project.mjs';
import type { checkedEditableAppProject } from '../app-project-assembly.mjs';
import { addCheckedSource, sourceProjectKey } from './public-app-assembly-model.mjs';
import { PublicAppAssemblyPanel } from './public-app-assembly-panel';
import { publicAppDefinitionFromImportedProject } from '../app-project-publish.mjs';
import { checkedPublicSiteUrl, streamPublicAppFolder, streamCopiedPublicSite, readPublicAppFolder } from '../public-app-import.mjs';
import { clearCopiedSiteCheckpoint, localHints, resumeCopiedSite } from '../public-app-copy-continuation.mjs';
import { runWorkshopTool } from './workshop-tool-api';
import { PlanNeeded, readFileJson, readJson } from './api';
import { registerLeaveCounter } from './leave-blockers';
import { sendQueuedJob } from './queue-job';
import { PublicAppSourcePanel } from './public-app-source-panel';
import { putSizesOnBoard, type BoardSpace } from './put-sizes-on-board';
import { useOfferedScreens } from './open-screen';
import { controlShown, useShowChange } from '../../parts/ui/show/show-rules/show-of';

type DomainRecord = { type: 'CNAME' | 'TXT'; name: string; value: string };
type PublicAppDomain = { host: string; url: string; status: 'active' | 'ended' | 'awaiting_dns' | 'awaiting_attachment' | 'retiring'; provider_readback?: { host: string; status: 'attached' | 'absent' | 'pending'; provider?: string; dns_records?: DomainRecord[] }; provider_checked_at?: string; address_record?: DomainRecord; verification_record?: DomainRecord };
type Installation = { installation_id: string; app_id: string; name?: string | null; public_url: string; ai_app_url?: string; status: string; space_title?: string; can_manage_domains?: boolean; can_manage_commerce?: boolean; custom_domains: PublicAppDomain[]; domains_loaded?: boolean };
type Commerce = { connection: { connection_id: string } | null; available_shops: { connection_id: string; label: string }[] };
type MerchantOrder = { id: string; name: string; created_at: string; payment_status: string; fulfillment_status: string; total: { amount: string; currencyCode: string } | null; items: { title: string; quantity: number }[]; more_items: boolean };
type VisitorAction = { id: string; record_kind: string; fields: { id: string; type: string; required: boolean }[] };
type Placement = { id: string; page_path: string; access: 'public' | 'signed-in'; capability: { kind: string; id: string; version: string; operation?: 'open' | 'run' }; presentation?: PublicCardPresentation };
// The card panel edits a published capability's card words; a visitor form placed on a page (a sign-up) keeps other words
// (its fields, submit label, done message), so only a placement holding card words opens the panel.
const isCard = (row: Placement) => typeof row.presentation?.title === 'string' && typeof row.presentation.description === 'string'
  && (row.presentation.style === 'card' || row.presentation.style === 'plain');
type FileRef = { blob_ref: string; media_type: string; size: number };
type IndexedFileRow = { path: string; blob_ref: string; media_type: string; size: number };
type IndexedFile = { path: string; content: string; revision: string; draft_revision: string | null; placed_capabilities?: Placement[] };
type Source = { id: string; actions: VisitorAction[]; files: Record<string, string | FileRef>; placed_capabilities?: Placement[]; revision: string; public_url: string; file_index?: Record<string, unknown> };
type Draft = { draft: Source | null };
type ProjectAssembly = Awaited<ReturnType<typeof checkedEditableAppProject>> & {
  source_files: Record<string, Record<string, FileRef>>;
  source_files_revision: string;
  editor_files: Record<string, string | FileRef>;
};
type ProjectRoute = { id: string; source: string; path: string; source_path: string; targets: string[]; presenter?: { kind: string } };
type Versions = { current_revision: string; versions: string[]; addresses?: Record<string, string>; history?: { revision: string; number: number; created_at: string | null; by: string | null; words: string | null; live: boolean }[] };
type Analytics = { page_views: number; unique_visitors: number; submissions: number; days: { date: string; page_views: number; unique_visitors: number; submissions: number }[] };
type Imported = Awaited<ReturnType<typeof readPublicAppFolder>> & {
  source_url?: string; skipped?: { address: string; reason: string }[]; source_file_path?: string; site_file_identity?: string;
  files_index?: { schema: string; version: number; root: string; file_count: number; page_count: number; byte_count: number };
  file_import?: { import_id: string; session_id: string }; page_count?: number;
};
type VisitorView = {
  source_label: string; title: string; description: string;
  sections?: { heading?: string; text?: string; items?: { label?: string; text?: string }[] }[];
  actions?: { label: string }[];
};
type CatalogEntry = { id: string; group: string; label: string; detail: string; href: string; context?: string; version?: string; capabilityKind?: string; operations?: string[]; view?: VisitorView };
type StudiedScreenRow = { id: string; title: string; fields: { title?: unknown; app?: unknown; platform?: unknown; screen_kind?: unknown; anatomy?: unknown; patterns?: unknown; source_url?: unknown } };
type Props = { surfaceInput?: Record<string, unknown> };
const url = (id: string) => `/work/api/public-app/installations/${id}`;
const sourceProjectUrl = (id: string) => `/work/api/source-projects/${id}`;
const sentence = (value: string) => { const spaced = value.replace(/[-_]+/g, ' ').trim(); return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : value; };
/** A page's name from its route: / is Home, /about/ is About, /flavours/caramel is Caramel. */
const pageName = (route: string) => {
  const parts = route.split(/[?#]/)[0].split('/').filter(Boolean).map(part => part.replace(/\.html?$/, '')).filter(part => part !== 'index');
  return parts.length ? sentence(decodeURIComponent(parts[parts.length - 1])) : 'Home';
};
const isHtmlFile = (path: string) => /\.html?$/i.test(path);
const routeForIndexedFile = (path: string) => {
  const clean = path.replace(/^\/+/, '');
  if (/^index\.html?$/i.test(clean)) return '/';
  if (/\/index\.html?$/i.test(clean)) return `/${clean.replace(/\/index\.html?$/i, '')}/`;
  return `/${clean}`;
};
const withAssemblyEditorFiles = (source: Source, assembly: ProjectAssembly) =>
  checkedPublicAppEditorSource({ ...source, files: { ...source.files, ...assembly.editor_files } });
const routesForSource = (assembly: ProjectAssembly | null) => assembly?.sources.flatMap(row =>
  row.project.source.origin?.kind === 'github-repository' && row.project.pages.some(page => page.presenter.kind === 'hosted-web')
    ? row.project.pages.map(page => ({ project_id: row.project.source.origin.project_id, path: page.path }))
    : []) ?? [];
/** Each site once, by a name a person reads: live ones first; two copies of one app are told apart by their space or
 *  by a number, never by their address. */
const siteChoices = (installations: Installation[]) => {
  const named = (rows: Installation[]) => {
    const seen = new Map<string, number>();
    return rows.map(item => {
      const base = `${sentence(item.name ?? item.app_id)}${item.space_title ? ` · ${item.space_title}` : ''}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return { id: item.installation_id, name: count > 1 ? `${base} (${count})` : base };
    });
  };
  return { live: named(installations.filter(item => item.status === 'active')), ended: named(installations.filter(item => item.status !== 'active')) };
};
/** How long a cursor or an AI's change stays on the canvas after it was last heard from. */
const PRESENCE_TTL_MS = 12_000;
const domainState = { active: 'Live', ended: 'Disconnected', awaiting_dns: 'Add DNS records', awaiting_attachment: 'Waiting for hosting confirmation', retiring: 'App stopped; waiting for hosting confirmation' } as const;

/** Open the owner's site picker from its durable index without waiting for the account store. */
async function readPublicApps(): Promise<{ installations: Installation[]; spaces: BoardSpace[] }> {
  const initial = await readJson<{ installations: Installation[] }>('/work/api/public-app/installations?initial=1');
  return { installations: initial.installations, spaces: [] };
}

/** Reconcile legacy installations and shared Space sites after the picker is visible. */
async function readAllPublicApps(): Promise<{ installations: Installation[]; spaces: BoardSpace[]; installations_read: boolean; spaces_read: boolean }> {
  const [ownedResult, spacesResult] = await Promise.allSettled([
    readJson<{ installations: Installation[] }>('/work/api/public-app/installations'),
    readJson<{ spaces: BoardSpace[] }>('/work/api/spaces'),
  ]);
  const owned = ownedResult.status === 'fulfilled' ? ownedResult.value : { installations: [] };
  const spacesRead = spacesResult.status === 'fulfilled';
  const spaces = spacesRead ? spacesResult.value.spaces : [];
  const shared = await Promise.allSettled(spaces.map(async space => {
    const result = await readJson<{ installations: { installation_id: string; definition: { id: string }; public_url: string; status: string; custom_domains: Installation['custom_domains'] }[] }>(`/work/api/public-app/installations?space_id=${encodeURIComponent(space.space_id)}`);
    return result.installations.map(item => ({ ...item, app_id: item.definition.id, space_title: space.title }));
  }));
  const installations = [...new Map([...owned.installations, ...shared.flatMap(result => result.status === 'fulfilled' ? result.value : [])].map(item => [item.installation_id, item])).values()] as Installation[];
  return { installations, spaces, installations_read: ownedResult.status === 'fulfilled', spaces_read: spacesRead };
}

function PublicApps({ surfaceInput, loaded }: Props & { loaded: { installations: Installation[]; spaces: BoardSpace[] } }) {
  // Asking your AI to edit a selected part of a page is the control `ai.page-edit` (parts/ui part.json).
  useShowChange();
  const requestedSpaceId = typeof surfaceInput?.space_id === 'string' ? surfaceInput.space_id : null;
  const [installations, setInstallations] = useState<Installation[]>(loaded.installations);
  const [selected, setSelected] = useState(typeof surfaceInput?.installation_id === 'string' ? surfaceInput.installation_id
    : loaded.installations.find(item => item.status === 'active')?.installation_id || loaded.installations[0]?.installation_id || '');
  const [source, setSource] = useState<Source | null>(null);
  const [draft, setDraft] = useState<Source | null>(null);
  const [working, setWorking] = useState<Source | null>(null);
  const [projectAssembly, setProjectAssembly] = useState<ProjectAssembly | null>(null);
  const [siteLoadStatus, setSiteLoadStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [projectSourceKey, setProjectSourceKey] = useState<string | null>(null);
  const [projectRouteId, setProjectRouteId] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState('index.html');
  const [indexedFiles, setIndexedFiles] = useState<IndexedFileRow[]>([]);
  const [indexedCursor, setIndexedCursor] = useState<string | null>(null);
  const [indexedMore, setIndexedMore] = useState(false);
  const [indexedFilesStatus, setIndexedFilesStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [indexedSelectedPath, setIndexedSelectedPath] = useState('');
  const [indexedLoaded, setIndexedLoaded] = useState<IndexedFile | null>(null);
  const [indexedContents, setIndexedContents] = useState<Record<string, string>>({});
  const [indexedBusy, setIndexedBusy] = useState(false);
  const indexedRead = useRef(0);
  const siteRead = useRef(0);
  const selectedSite = useRef(selected);
  selectedSite.current = selected;
  const indexedState = useRef({ source, draft, working, indexedContents });
  indexedState.current = { source, draft, working, indexedContents };
  const [versions, setVersions] = useState<Versions | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [versionsStatus, setVersionsStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [analyticsStatus, setAnalyticsStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [assemblyStatus, setAssemblyStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [domainsStatus, setDomainsStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [versionsRetry, setVersionsRetry] = useState(0);
  const [analyticsRetry, setAnalyticsRetry] = useState(0);
  const [pane, setPane] = useState(loaded.installations.length ? 'design' : 'settings');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [needsPlan, setNeedsPlan] = useState(false);
  const [imported, setImported] = useState<Imported | null>(null);
  const [importName, setImportName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [domainName, setDomainName] = useState('');
  const [appName, setAppName] = useState('');
  const [commerce, setCommerce] = useState<Commerce | null>(null);
  const [shopChoice, setShopChoice] = useState('');
  const [orders, setOrders] = useState<MerchantOrder[] | null>(null);
  const [ordersCursor, setOrdersCursor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [references, setReferences] = useState<EditorReference[]>([]);
  const [referencesQuery, setReferencesQuery] = useState('');
  const [referencesStatus, setReferencesStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [selection, setSelection] = useState<VisualSelectionRef | null>(null);
  const [editRequest, setEditRequest] = useState('');
  const [spaces, setSpaces] = useState<BoardSpace[]>(loaded.spaces);
  const [spacesRead, setSpacesRead] = useState(false);
  const [spacesReadFailed, setSpacesReadFailed] = useState(false);
  const [workWith, setWorkWith] = useState(() => requestedSpaceId ? `requested:${requestedSpaceId}` : 'private');
  const [boardSpace, setBoardSpace] = useState(loaded.spaces[0]?.space_id ?? '');
  const [screenId, setScreenId] = useState('');
  const [visualReady, setVisualReady] = useState(false);
  const [fullListLoaded, setFullListLoaded] = useState(false);
  const indexedSource = Boolean(source?.file_index);
  useEffect(() => {
    let live = true;
    void readAllPublicApps().then(result => {
      if (!live) return;
      setInstallations(current => [...new Map([...current, ...result.installations].map(row => [row.installation_id, row])).values()]);
      setSpaces(result.spaces);
      setSpacesRead(result.spaces_read);
      setSpacesReadFailed(!result.spaces_read);
      setBoardSpace(current => current || result.spaces[0]?.space_id || '');
      if (requestedSpaceId) {
        const verified = result.spaces.find(space => space.space_id === requestedSpaceId);
        setWorkWith(current => current === `requested:${requestedSpaceId}`
          ? verified ? `space:${verified.space_id}` : `unavailable:${requestedSpaceId}`
          : current);
      }
      setSelected(current => current || result.installations.find(row => row.status === 'active')?.installation_id || result.installations[0]?.installation_id || '');
      setFullListLoaded(result.installations_read);
      if (!result.installations_read) setMessage('Your installed sites could not be reloaded. Existing sites remain available.');
    }).catch(error => {
      if (!live) return;
      setMessage(errorWords(error));
    });
    return () => { live = false; };
  }, []);
  const selectedDomainsLoaded = installations.find(item => item.installation_id === selected)?.domains_loaded !== false;
  useEffect(() => {
    if (!selected || selectedDomainsLoaded) { setDomainsStatus('ready'); return; }
    let live = true;
    setDomainsStatus('loading');
    void readJson<{ custom_domains: PublicAppDomain[] }>(`${url(selected)}/domains`).then(result => {
      if (!live) return;
      setInstallations(rows => rows.map(row => row.installation_id === selected ? { ...row, custom_domains: result.custom_domains, domains_loaded: true } : row));
      setDomainsStatus('ready');
    }).catch(() => { if (live) setDomainsStatus('failed'); });
    return () => { live = false; };
  }, [selected, selectedDomainsLoaded]);
  // A newly installed site can precede the first list read after a reload. Refresh only an initially empty
  // screen, so an empty result does not leave a real site invisible for the rest of this visit.
  useEffect(() => {
    if (loaded.installations.length) return;
    let stopped = false;
    let recovered = false;
    const timers = [500, 2000, 8000].map(delay => window.setTimeout(() => {
      if (stopped || recovered) return;
      void readPublicApps().then(latest => {
        if (stopped || recovered || !latest.installations.length) return;
        recovered = true;
        timers.forEach(timer => window.clearTimeout(timer));
        setInstallations(current => current.length ? current : latest.installations);
        setSelected(current => current || latest.installations.find(item => item.status === 'active')?.installation_id || latest.installations[0].installation_id);
      }).catch(() => {});
    }, delay));
    return () => { stopped = true; timers.forEach(timer => window.clearTimeout(timer)); };
  }, [loaded.installations.length]);
  const screens = useOfferedScreens().filter(row => Array.isArray(row.route_paths) && typeof row.route_paths[0] === 'string' && row.label) as (ReturnType<typeof useOfferedScreens>[number] & { route_paths: string[]; label: string })[];
  const visual = useRef<VisualHtmlEditorHandle>(null);
  // Unsaved edits in the visual editor are asked for when the page is left (leave-blockers.ts).
  useEffect(() => registerLeaveCounter('edit', () => (visual.current?.hasUnsavedChanges() ? 1 : 0)), []);
  // Everyone else working on this site (other people, this person's other tabs, their AIs), through the same live room
  // a space's board uses (src/board-room.mjs, room `public-app:<installation id>`).
  const [presence, setPresence] = useState<PresenceState>(EMPTY_PRESENCE);
  const [now, setNow] = useState(() => Date.now());
  const channel = useRef<PresenceChannel | null>(null);
  const self = useMemo(() => `tab-${Math.random().toString(36).slice(2)}`, []);
  const someoneChanged = useRef<(name: string) => void>(() => {});
  const peerRead = useRef(0);
  const pendingPeer = useRef<{ site: string; name: string } | null>(null);
  const peerState = useRef({ busy, selectedPage });
  peerState.current = { busy, selectedPage };
  const pages = useMemo(() => {
    if (!working) return [];
    if (indexedSource) {
      return indexedLoaded && isHtmlFile(indexedLoaded.path)
        ? [{ id: indexedLoaded.path, route: routeForIndexedFile(indexedLoaded.path), html_path: indexedLoaded.path, visual_supported: true }]
        : [];
    }
    return publicAppEditorRoutePages(working);
  }, [working, indexedSource, indexedLoaded]);
  const sourceRoutes = useMemo(() => routesForSource(projectAssembly), [projectAssembly]);
  const imageAssets = useMemo(() => indexedSource
    ? indexedFiles.flatMap(row => row.media_type.startsWith('image/') ? [{ path: row.path, url: `/${row.path.split('/').map(encodeURIComponent).join('/')}`, label: row.path.split('/').at(-1)?.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') ?? row.path, mediaType: row.media_type }] : [])
    : working ? publicAppEditorImageAssets(working) : [], [indexedSource, indexedFiles, working]);
  const publishedPagePath = useMemo(() => source
    ? indexedSource ? routeForIndexedFile(indexedSelectedPath && isHtmlFile(indexedSelectedPath) ? indexedSelectedPath : selectedPage)
      : publicAppEditorRoutePages(source).find(page => page.id === selectedPage)?.route
    : undefined, [source, selectedPage, indexedSource, indexedSelectedPath]);
  const canManageCommerce = installations.find(item => item.installation_id === selected)?.can_manage_commerce === true;
  const editorPage = useMemo(() => pages.find(page => page.id === selectedPage) ?? pages.find(page => page.id === 'index.html') ?? pages[0] ?? null, [pages, selectedPage]);
  const placementPagePath = indexedSource && indexedLoaded ? indexedLoaded.path : editorPage?.html_path;
  const projectRoutes = useMemo(() => ((projectAssembly?.pages ?? []) as ProjectRoute[]).filter(page => page.targets.includes('web')), [projectAssembly]);
  const projectRoute = projectRoutes.find(page => page.id === projectRouteId) ?? projectRoutes.find(page => page.path === editorPage?.route) ?? projectRoutes[0] ?? null;
  const activeProjectSource = projectSourceKey && projectAssembly?.sources.some(row => row.key === projectSourceKey)
    ? projectSourceKey : projectRoute?.source ?? projectAssembly?.sources[0]?.key ?? null;
  const projectSourceRoutes = projectRoutes.filter(page => page.source === activeProjectSource);
  const selectedSourceRoute = projectSourceRoutes.find(page => page.id === projectRouteId) ?? projectSourceRoutes.find(page => page.path === editorPage?.route) ?? projectSourceRoutes[0] ?? null;
  const selectedProjectSource = projectAssembly?.sources.find(row => row.key === activeProjectSource);
  const routeInCanvas = !projectAssembly || !projectAssembly.sources.length || Boolean(selectedSourceRoute && editorPage?.route === selectedSourceRoute.path);
  const indexedEditorSource = useMemo(() => {
    if (!indexedSource || !working || !indexedLoaded || !isHtmlFile(indexedLoaded.path)) return working;
    const page = working.files[indexedLoaded.path];
    if (typeof page !== 'string') return working;
    const styles = Object.fromEntries(cssLinks(page, indexedLoaded.path).flatMap(path => {
      const value = working.files[path]; return typeof value === 'string' ? [[path, value]] : [];
    }));
    const placed_capabilities = working.placed_capabilities?.filter(row => row.page_path === indexedLoaded.path);
    return checkedPublicAppEditorSource({ ...working, files: { ...styles, 'index.html': page, [indexedLoaded.path]: page }, placed_capabilities });
  }, [indexedSource, working, indexedLoaded]);
  const model = useMemo(() => indexedEditorSource && editorPage && (!indexedSource || isHtmlFile(indexedSelectedPath))
    ? grapesJsImportModel(indexedEditorSource, { htmlPath: editorPage.html_path, route: editorPage.route }) : null, [indexedEditorSource, editorPage, indexedSource, indexedSelectedPath]);
  const selectedCard = working?.placed_capabilities?.find(row => row.id === selectedCardId && row.page_path === placementPagePath && isCard(row));
  const selectedCatalogItem = selectedCard && catalog.find(item => item.capabilityKind === selectedCard.capability.kind && item.id === selectedCard.capability.id && item.version === selectedCard.capability.version);
  const selectedCardView = selectedCatalogItem?.view;

  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      readJson<{ tools: { id: string; title: string; text: string; byline?: string; runs_on?: string[] }[] }>('/work/api/workshop'),
      readJson<{ rows: { id: string; title: string; description?: string; made_by?: string; components?: { title?: string }[] }[] }>('/work/api/marketplace/configurations'),
      readJson<{ workflows: { workflow_id: string; label: string; job: string; made_by?: string }[] }>('/work/api/workflows'),
      readJson<{ rows: { kind: string; id: string; version: string; title: string; description: string; url: string; operations?: string[]; view?: VisitorView & { source_label?: string } }[] }>('/work/api/public-app/placeable'),
    ]).then(results => {
      if (!live) return;
      const ready = <T,>(index: number): T | null => results[index].status === 'fulfilled' ? results[index].value as T : null;
      const placeable = ready<{ rows: { kind: string; id: string; version: string; title: string; description: string; url: string; operations?: string[]; view?: VisitorView }[] }>(3)?.rows ?? [];
      const placeableKeys = new Set(placeable.map(row => `${row.kind}/${row.id}`));
      setCatalog([
        ...(ready<{ tools: { id: string; title: string; text: string; byline?: string; runs_on?: string[] }[] }>(0)?.tools ?? []).filter(row => !placeableKeys.has(`workshop-tool/${row.id}`)).map(row => ({ id: row.id, label: row.title, detail: row.text, context: row.byline ?? row.runs_on?.join(' · '), group: 'Tool', href: '/marketplace' })),
        ...(ready<{ rows: { id: string; title: string; description?: string; made_by?: string; components?: { title?: string }[] }[] }>(1)?.rows ?? []).filter(row => !placeableKeys.has(`marketplace-configuration/${row.id}`)).map(row => {
          const included = (row.components ?? []).map(component => component.title).filter((title): title is string => Boolean(title?.trim()));
          return { id: row.id, label: row.title, detail: [row.description, included.length ? `Includes: ${included.join(' · ')}` : ''].filter(Boolean).join(' '),
            context: row.made_by === 'this account' ? 'Your Marketplace listing' : 'Marketplace listing', group: 'Marketplace', href: '/marketplace' };
        }),
        ...(ready<{ workflows: { workflow_id: string; label: string; job: string; made_by?: string }[] }>(2)?.workflows ?? []).filter(row => !placeableKeys.has(`published-workflow/${row.workflow_id}`)).map(row => ({ id: row.workflow_id, label: row.label, detail: row.job, context: row.made_by ? `From ${row.made_by}` : 'Published workflow', group: 'Workflow', href: '/workflows' })),
        ...placeable.map(row => ({
          id: row.id, version: row.version, capabilityKind: row.kind, operations: row.operations, view: row.view, label: row.title, detail: row.description,
          context: row.view?.source_label ?? (row.kind === 'workshop-screen' ? 'Published Workshop screen' : row.kind === 'workshop-tool' ? 'Published Workshop tool' : row.kind === 'marketplace-configuration' ? 'Marketplace listing' : 'Published workflow'),
          group: row.kind === 'published-workflow' ? 'Workflow' : row.kind === 'workshop-screen' ? 'Shared screen' : row.kind === 'marketplace-configuration' ? 'Marketplace' : 'Tool', href: row.url,
        })),
      ]);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setReferencesStatus('loading');
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ dataset: 'studied-screens', limit: '30' });
      if (referencesQuery.trim()) params.set('q', referencesQuery.trim());
      void readJson<{ rows: StudiedScreenRow[] }>(`/work/api/shared-library?${params.toString()}`).then(result => {
        if (!live) return;
        const rows = Array.isArray(result.rows) ? result.rows : [];
        setReferences(rows.flatMap(row => {
          const fields = row.fields ?? {};
          if (typeof fields.source_url !== 'string' || !/^https:\/\//i.test(fields.source_url)) return [];
          const word = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
          return [{
            id: row.id,
            title: row.title || word(fields.title, 'Screen reference'),
            app: word(fields.app, 'Unknown app'),
            platform: word(fields.platform, 'Unknown platform'),
            screenKind: word(fields.screen_kind, 'Screen'),
            anatomy: word(fields.anatomy),
            patterns: Array.isArray(fields.patterns) ? fields.patterns.filter((value): value is string => typeof value === 'string') : [],
            sourceUrl: fields.source_url,
          }];
        }));
        setReferencesStatus('ready');
      }).catch(() => {
        if (live) { setReferences([]); setReferencesStatus('failed'); }
      });
    }, referencesQuery ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [referencesQuery]);

  const reload = async (id: string) => {
    const selection = siteRead.current;
    const isCurrent = () => selectedSite.current === id && selection === siteRead.current;
    if (!isCurrent()) return;
    setSiteLoadStatus('loading');
    try {
    const indexedCurrent = await readJson<Source>(url(id));
    if (!isCurrent()) return;
    if (indexedCurrent.file_index) {
      const indexedEditorSource = { ...indexedCurrent, files: {} };
      setSource(indexedCurrent); setWorking(indexedEditorSource); setDraft(null); setIndexedFiles([]); setIndexedCursor(null); setIndexedContents({}); setIndexedLoaded(null);
      setProjectAssembly(null); setAssemblyStatus('loading'); setSelectedCardId(null); setSiteLoadStatus('ready');
      await Promise.all([loadIndexedFiles(id, false, indexedEditorSource), reloadProjectAssembly(id)]);
      return;
    }
    const [current, saved] = await Promise.all([readJson<Source>(url(id)), readJson<Draft>(`${url(id)}/draft`)]);
    if (!isCurrent()) return;
    const nextWorking = saved.draft ?? current;
    setSource(current); setDraft(saved.draft); setWorking(nextWorking); setSelectedCardId(nextWorking.placed_capabilities?.find(isCard)?.id ?? null);
    setSiteLoadStatus('ready');
    setVersions(null); setAnalytics(null); setAssemblyStatus('loading');
    void reloadProjectAssembly(id).then(assembly => {
      if (!isCurrent()) return;
      setWorking(working => working && !visual.current?.hasUnsavedChanges() ? withAssemblyEditorFiles(working, assembly) : working);
      setAssemblyStatus('ready');
    }).catch(() => { if (isCurrent()) setAssemblyStatus('failed'); });
    } catch (error) { if (isCurrent()) { setSiteLoadStatus('failed'); throw error; } }
  };
  const reloadProjectAssembly = async (id: string) => {
    const siteSelection = siteRead.current;
    setAssemblyStatus('loading');
    try {
      const assembly = await readJson<ProjectAssembly>(`${url(id)}/project/assembly`);
      if (selectedSite.current !== id || siteSelection !== siteRead.current) return assembly;
      setProjectAssembly(assembly); setAssemblyStatus('ready');
      return assembly;
    } catch (error) { if (selectedSite.current === id && siteSelection === siteRead.current) setAssemblyStatus('failed'); throw error; }
  };
  useEffect(() => {
    if (!selected) return;
    let live = true;
    ++siteRead.current;
    ++indexedRead.current;
    setCommerce(null); setShopChoice(''); setOrders(null); setOrdersCursor(null);
    if (canManageCommerce) {
      void readJson<Commerce>(`${url(selected)}/commerce`).then(result => {
        if (!live) return;
        setCommerce(result);
        setShopChoice(result.connection?.connection_id ?? result.available_shops[0]?.connection_id ?? '');
      }).catch(error => { if (live) setMessage(errorWords(error)); });
    }
    setSiteLoadStatus('loading'); setAssemblyStatus('loading'); setVersionsStatus('loading'); setAnalyticsStatus('loading');
    setSource(null); setDraft(null); setWorking(null); setProjectAssembly(null); setSelectedPage('index.html'); setProjectSourceKey(null); setProjectRouteId(null); setSelection(null); setVersions(null); setAnalytics(null);
    setIndexedFiles([]); setIndexedCursor(null); setIndexedMore(false); setIndexedFilesStatus('idle'); setIndexedSelectedPath(''); setIndexedLoaded(null); setIndexedContents({}); setIndexedBusy(false);
    void readJson<Source>(url(selected)).then(async current => {
      if (!live) return;
      if (current.file_index) {
        const indexedEditorSource = { ...current, files: {} };
        setSource(current); setWorking(indexedEditorSource); setDraft(null); setSelectedCardId(null); setSiteLoadStatus('ready'); setProjectAssembly(null);
        void reloadProjectAssembly(selected).catch(() => { if (live) setAssemblyStatus('failed'); });
        await loadIndexedFiles(selected, false, indexedEditorSource);
        return;
      }
      const saved = await readJson<Draft>(`${url(selected)}/draft`);
      if (!live) return;
      const nextWorking = saved.draft ?? current;
      setSource(current); setDraft(saved.draft); setWorking(nextWorking); setSelectedCardId(nextWorking.placed_capabilities?.find(isCard)?.id ?? null); setSiteLoadStatus('ready');
      void readJson<ProjectAssembly>(`${url(selected)}/project/assembly`).then(assembly => {
        if (!live) return;
        setProjectAssembly(assembly);
        setWorking(working => working && !visual.current?.hasUnsavedChanges() ? withAssemblyEditorFiles(working, assembly) : working);
        setAssemblyStatus('ready');
      }).catch(() => { if (live) setAssemblyStatus('failed'); });
    }).catch(error => { if (live) { setMessage(errorWords(error)); setSiteLoadStatus('failed'); } });
    return () => { live = false; ++siteRead.current; ++indexedRead.current; };
  }, [selected, canManageCommerce]);
  useEffect(() => {
    if (!selected || pane !== 'history' || versions) return;
    let live = true;
    setVersionsStatus('loading');
    void readJson<Versions>(`${url(selected)}/versions`).then(result => { if (live) { setVersions(result); setVersionsStatus('ready'); } })
      .catch(() => { if (live) setVersionsStatus('failed'); });
    return () => { live = false; };
  }, [selected, pane, versions, versionsRetry]);
  useEffect(() => {
    if (!selected || pane !== 'activity' || analytics) return;
    let live = true;
    setAnalyticsStatus('loading');
    void readJson<Analytics>(`${url(selected)}/analytics`).then(result => { if (live) { setAnalytics(result); setAnalyticsStatus('ready'); } })
      .catch(() => { if (live) setAnalyticsStatus('failed'); });
    return () => { live = false; };
  }, [selected, pane, analytics, analyticsRetry]);

  useEffect(() => {
    if (!selected) return;
    setPresence(EMPTY_PRESENCE);
    const opened = openPresenceRoom(`public-app:${selected}`, update => {
      if (selectedSite.current !== selected) return;
      setPresence(state => upsertPresence(state, update));
      if (update.doing) someoneChanged.current(update.name);
    });
    channel.current = opened;
    const tick = setInterval(() => { const at = Date.now(); setNow(at); setPresence(state => pruneStale(state, at, PRESENCE_TTL_MS)); }, 1000);
    return () => { clearInterval(tick); opened.close(); if (channel.current === opened) channel.current = null; };
  }, [selected]);
  // Someone else (a person or an AI) saved this draft: their change is taken into the open page part by part, keeping
  // what is unsaved here; a change the page cannot take in place opens it again, or, with unsaved work here, says so.
  someoneChanged.current = name => {
    if (!selected) return;
    if (peerState.current.busy) { pendingPeer.current = { site: selected, name }; return; }
    pendingPeer.current = null;
    if (indexedSource) {
      if (!indexedSelectedPath) return;
      void readIndexedFile(selected, indexedSelectedPath, undefined, indexedFiles, name)
        .catch(error => {
          if (selectedSite.current === selected) setMessage(errorWords(error, `${name} changed this file. Reopen it to see the change.`));
        });
      return;
    }
    const siteSelection = siteRead.current;
    const pageSelection = selectedPage;
    const request = ++peerRead.current;
    const isCurrent = () => selectedSite.current === selected && siteSelection === siteRead.current
      && pageSelection === peerState.current.selectedPage && request === peerRead.current && !peerState.current.busy;
    void Promise.all([readJson<Draft>(`${url(selected)}/draft`), readJson<ProjectAssembly>(`${url(selected)}/project/assembly`)]).then(([saved, assembly]) => {
      if (!isCurrent()) {
        if (selectedSite.current === selected && siteSelection === siteRead.current
          && pageSelection === peerState.current.selectedPage && request === peerRead.current && peerState.current.busy) {
          pendingPeer.current = { site: selected, name };
        }
        return;
      }
      if (!saved.draft || saved.draft.revision === draft?.revision) return;
      const next = withAssemblyEditorFiles(saved.draft, assembly);
      const nextModel = editorPage ? grapesJsImportModel(next, { htmlPath: editorPage.html_path, route: editorPage.route }) : null;
      const taken = Boolean(nextModel && visual.current?.takeChanges(nextModel.html, nextModel.css.map(file => file.content).join('\n'), nextModel.canvas_css));
      if (!taken && visual.current?.hasUnsavedChanges()) { setMessage(`${name} changed this draft while you were editing. Save yours, then reopen the site to see both.`); return; }
      setProjectAssembly(assembly); setDraft(saved.draft); setWorking(next);
    }).catch(error => { if (isCurrent()) setMessage(errorWords(error, `${name} changed this draft. Reopen the site to see it.`)); });
  };
  useEffect(() => {
    if (busy) return;
    const pending = pendingPeer.current;
    pendingPeer.current = null;
    if (pending?.site === selected) someoneChanged.current(pending.name);
  }, [busy, selected]);
  // Where this person points and what they chose, said again every few seconds so a still cursor stays drawn for others.
  const lastPointer = useRef(0);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const tell = () => channel.current?.publish({ id: self, name: 'You', ts: Date.now(), ...(pointer.current ? { cursor: pointer.current } : {}), ...(selection ? { target: { selector: selection.selector, ...(selection.element ? { element: selection.element } : {}) } } : {}) });
  const pointAt = (point: { x: number; y: number } | null) => {
    pointer.current = point;
    if (point && Date.now() - lastPointer.current < 50) return;
    lastPointer.current = Date.now();
    tell();
  };
  const tellRef = useRef(tell);
  tellRef.current = tell;
  useEffect(() => { tellRef.current(); }, [selection]);
  useEffect(() => { const heartbeat = setInterval(() => tellRef.current(), 4000); return () => clearInterval(heartbeat); }, [selected]);
  const peers: CanvasPeer[] = activeParticipants(presence, now, PRESENCE_TTL_MS, self).map(peer => ({
    id: peer.id, name: peer.name, color: colorForParticipant(peer.id), ...(peer.cursor ? { cursor: peer.cursor } : {}), ...(peer.target ? { target: peer.target } : {}), ...(peer.doing ? { doing: peer.doing } : {}),
  }));

  const act = async (job: () => Promise<void>, { rethrow = false }: { rethrow?: boolean } = {}) => {
    setBusy(true); setMessage(''); setNeedsPlan(false);
    try { await job(); } catch (error) {
      if (error instanceof PlanNeeded) { setNeedsPlan(true); setMessage(planNeededTitle(error.upgrade_needed)); }
      else setMessage(errorWords(error, 'This app could not be changed.'));
      if (rethrow) throw error;
    }
    finally { setBusy(false); }
  };
  const keepDomain = (installationId: string, domain: PublicAppDomain) => {
    setInstallations(rows => rows.map(row => row.installation_id !== installationId ? row : {
      ...row, custom_domains: [...row.custom_domains.filter(current => current.host !== domain.host), domain].sort((a, b) => a.host.localeCompare(b.host)),
    }));
  };
  const changeDomain = async (installationId: string, init: RequestInit) => {
    try { return await readJson<PublicAppDomain>(`${url(installationId)}/domains`, init); }
    catch (error) {
      // A pending certificate or a lost mutation reply can still leave new DNS
      // proof or retirement state. Read the owner before offering another action.
      try {
        const latest = await readJson<{ custom_domains: PublicAppDomain[] }>(`${url(installationId)}/domains`);
        setInstallations(rows => rows.map(row => row.installation_id === installationId
          ? { ...row, custom_domains: latest.custom_domains, domains_loaded: true } : row));
      } catch { /* Keep the original mutation failure when its readback is unavailable. */ }
      throw error;
    }
  };
  const connectShop = () => act(async () => {
    if (!selected || !shopChoice) return;
    await readJson(`${url(selected)}/commerce`, { method: 'PUT', body: JSON.stringify({ connection_id: shopChoice }) });
    setCommerce(current => current ? { ...current, connection: { connection_id: shopChoice } } : current);
    setOrders(null); setOrdersCursor(null);
    setMessage('This site now uses products and checkout from the selected Shopify store.');
  });
  const disconnectShop = () => act(async () => {
    if (!selected) return;
    await readJson(`${url(selected)}/commerce`, { method: 'DELETE' });
    setCommerce(current => current ? { ...current, connection: null } : current);
    setOrders(null); setOrdersCursor(null);
    setMessage('This site is no longer selling products.');
  });
  const loadOrders = (after: string | null = null) => act(async () => {
    if (!selected) return;
    const suffix = after ? `?after=${encodeURIComponent(after)}` : '';
    const result = await readJson<{ orders: MerchantOrder[]; next_cursor: string | null }>(`${url(selected)}/commerce/orders${suffix}`);
    setOrders(current => after && current ? [...current, ...result.orders] : result.orders);
    setOrdersCursor(result.next_cursor);
  });
  // The app's readable address (src/public-app-names.mjs): renaming keeps the earlier name sending visitors on.
  const renameApp = () => act(async () => {
    if (!selected || !appName.trim()) return;
    const result = await readJson<{ name: string; public_url: string }>(`${url(selected)}/name`, { method: 'PUT', body: JSON.stringify({ name: appName.trim() }) });
    setInstallations(rows => rows.map(row => row.installation_id === selected ? { ...row, name: result.name, public_url: result.public_url } : row));
    setAppName('');
    setMessage(`This site is now at ${result.public_url}. The old address sends visitors there.`);
  });
  const claimDomain = () => act(async () => {
    if (!selected || !domainName.trim()) return;
    const result = await changeDomain(selected, { method: 'POST', body: JSON.stringify({ action: 'claim', host: domainName }) });
    keepDomain(selected, result); setDomainName('');
    setMessage('Add the TXT and CNAME records shown below. Then verify the domain to let Trillion check the provider connection.');
  }, { rethrow: true });
  const activateDomain = (host: string) => act(async () => {
    if (!selected) return;
    const result = await changeDomain(selected, { method: 'POST', body: JSON.stringify({ action: 'activate', host }) });
    keepDomain(selected, result);
    setMessage(result.status === 'active' ? 'The provider confirmed this domain and the public app is live there.' : 'The hosting provider has not confirmed this domain yet.');
  }, { rethrow: true });
  // Offline, the site's address and its domains show not found while its visitor responses stay; back online it is at the same address.
  const setLive = (live: boolean) => act(async () => {
    if (!selected) return;
    const result = await readJson<{ status: string; public_url?: string }>(`${url(selected)}/live`, { method: 'PUT', body: JSON.stringify({ live }) });
    const latest = await readPublicApps();
    setInstallations(latest.installations);
    setMessage(result.status === 'active' ? `This site is back online at ${result.public_url}.` : 'This site is offline. Its visitor responses are kept.');
  });
  const retireDomain = (host: string) => act(async () => {
    if (!selected) return;
    const result = await changeDomain(selected, { method: 'DELETE', body: JSON.stringify({ host }) });
    keepDomain(selected, result);
    setMessage(result.status === 'ended' ? 'The provider confirmed that this domain was disconnected.' : 'Trillion stopped serving the app. The provider still needs to confirm the domain was disconnected.');
  }, { rethrow: true });
  const currentEdit = () => {
    if (!working || !visual.current || !editorPage) return working;
    const exported = visual.current.exportFiles();
    const editorSource = indexedSource ? indexedEditorSource : working;
    const editorHtmlPath = indexedSource ? 'index.html' : editorPage.html_path;
    const edited = applyGrapesJsExport(editorSource, { ...exported, expectedRevision: editorSource.revision, htmlPath: editorHtmlPath });
    if (!indexedSource) return edited;
    const { ['index.html']: selectedHtml, ...otherFiles } = edited.files;
    const otherPlacements = working.placed_capabilities?.filter(row => row.page_path !== indexedSelectedPath) ?? [];
    const selectedPlacements = edited.placed_capabilities?.map(row => ({ ...row, page_path: indexedSelectedPath })) ?? [];
    return { ...working, files: { ...working.files, ...otherFiles, [indexedSelectedPath]: selectedHtml },
      placed_capabilities: [...otherPlacements, ...selectedPlacements] };
  };
  const saveIndexedFiles = async () => {
    if (!source || !selected || !indexedLoaded) throw new Error('Open a site file first.');
    const edited = isHtmlFile(indexedLoaded.path) ? currentEdit() : working;
    const changes = edited ? Object.entries(edited.files).flatMap(([path, value]) => typeof value === 'string'
      && value !== indexedContents[path] ? [{ path, content: value }] : []) : [];
    const placements = edited?.placed_capabilities ?? working?.placed_capabilities ?? [];
    const placementChanged = JSON.stringify(placements) !== JSON.stringify(source.placed_capabilities ?? []);
    if (!changes.length && !placementChanged) return { revision: source.revision, draft_revision: draft?.revision ?? indexedLoaded.draft_revision, preview_url: null };
    const writes: { path: string; content?: string }[] = changes.length ? changes : [{ path: indexedLoaded.path }];
    const siteSelection = siteRead.current;
    if (edited) setWorking(edited);
    let expectedRevision = source.revision;
    let expectedDraftRevision = draft?.revision ?? null;
    let result: { revision: string; draft_revision: string; preview_url?: string } | null = null;
    for (const file of writes) {
      result = await readJson<{ revision: string; draft_revision: string; preview_url?: string }>(`${url(selected)}/file`, {
        method: 'PUT', body: JSON.stringify({ path: file.path, ...(file.content === undefined ? {} : { content: file.content }),
          ...(file === writes.at(-1) ? { placed_capabilities: placements } : {}),
          expected_revision: expectedRevision, expected_draft_revision: expectedDraftRevision ?? null }),
      });
      expectedRevision = result.revision; expectedDraftRevision = result.draft_revision;
      if (selectedSite.current !== selected || siteSelection !== siteRead.current) return result;
      if (file.content !== undefined) setIndexedContents(rows => ({ ...rows, [file.path]: file.content }));
      // Keep each accepted write's revision even if a later file fails, so retry
      // saves the remaining edits rather than conflicting with our own write.
      const accepted = result;
      const savedPlacements = file === writes.at(-1) ? placements : source.placed_capabilities;
      setSource(current => current ? { ...current, revision: accepted.revision, placed_capabilities: savedPlacements } : current);
      setWorking(current => current ? { ...current, revision: accepted.revision } : current);
      setIndexedLoaded(current => current ? { ...current, revision: accepted.revision, draft_revision: accepted.draft_revision,
        content: file.path === current.path && file.content !== undefined ? file.content : current.content } : current);
      setDraft(current => ({ ...(current ?? source), revision: accepted.draft_revision, placed_capabilities: savedPlacements }));
      channel.current?.publish({ id: self, name: 'You', ts: Date.now(), doing: 'Saved', target: { text: file.path } });
    }
    return result;
  };
  const chooseIndexedFile = (path: string) => {
    try {
      const edited = visual.current?.hasUnsavedChanges() ? currentEdit() : working;
      if (edited) setWorking(edited);
      setSelection(null); setMessage('');
      setIndexedBusy(true);
      const read = readIndexedFile(selected, path);
      const selection = indexedRead.current;
      void read.catch(error => { if (selectedSite.current === selected && selection === indexedRead.current) setMessage(errorWords(error, 'This file could not load.')); })
        .finally(() => { if (selectedSite.current === selected && selection === indexedRead.current) setIndexedBusy(false); });
    } catch (error) { setMessage(errorWords(error, 'This file could not be changed.')); }
  };
  const choosePage = (path: string) => {
    try {
      const edited = visual.current?.hasUnsavedChanges() ? currentEdit() : working;
      if (edited) setWorking(edited);
      setSelectedPage(path);
      setSelectedCardId(edited?.placed_capabilities?.find(row => row.page_path === path && isCard(row))?.id ?? null);
      setSelection(null); setMessage('');
    } catch (error) { setMessage(errorWords(error, 'This page could not be changed.')); }
  };
  const chooseProjectRoute = (routeId: string) => {
    const route = projectRoutes.find(page => page.id === routeId);
    if (!route) return;
    const page = pages.find(item => item.route === route.path);
    if (page) choosePage(page.id);
    setProjectRouteId(route.id);
    setProjectSourceKey(route.source);
  };
  // Every save of the draft: shown here, and said to everyone else editing this site, whose open page takes it in.
  const putDraft = async (edited: Source) => {
    if (!source || !selected) throw new Error('Open a site first.');
    if (!projectAssembly || assemblyStatus !== 'ready') throw new Error('The saved site sources are still loading. Try again when they appear.');
    const complete = withAssemblyEditorFiles(edited, projectAssembly);
    const saved = (await readJson<Draft>(`${url(selected)}/draft`, { method: 'PUT', body: JSON.stringify({ ...complete, expected_revision: source.revision, expected_draft_revision: draft?.revision ?? null }) })).draft;
    if (saved) { setWorking(saved); setDraft(saved); channel.current?.publish({ id: self, name: 'You', ts: Date.now(), doing: 'Saved' }); }
    return saved;
  };
  const save = () => act(async () => {
    if (!source || !selected) return;
    if (indexedSource) {
      await saveIndexedFiles();
      setMessage('File saved as a draft. Your live site has not changed.');
      return;
    }
    const edited = currentEdit();
    if (!edited) return;
    await putDraft(edited);
    setMessage('Draft saved. Your live page has not changed.');
    void reloadProjectAssembly(selected).catch(() => setAssemblyStatus('failed'));
  });
  // A saved draft opens at its own address on the site's named host (public-app-names.json views): the first characters
  // of its revision, the separator, then the site's name. Only a named site has one.
  const previewAddress = (revisionOf: { revision?: string } | null) => {
    const installation = installations.find(item => item.installation_id === selected);
    if (!installation?.name || !revisionOf) return null;
    const host = new URL(installation.public_url).host;
    if (!host.startsWith(`${installation.name}.`)) return null; // host-text-ok: reads the site's own first label to build its draft address
    const view = /^1f:([a-f0-9]{64})$/.exec(revisionOf.revision ?? '')?.[1].slice(0, appNames.views.length);
    return view ? `https://${view}${appNames.views.separator}${host}/` : null;
  };
  // Saves what is on the canvas, then opens it at the draft's own address; the tab is opened at the press so it is not blocked.
  const previewDraft = () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    return act(async () => {
      if (!source || !selected || !projectAssembly) { tab?.close(); return; }
      const edited = currentEdit();
      if (!edited) return;
      const complete = withAssemblyEditorFiles(edited, projectAssembly);
      let saved = draft;
      if (!saved || complete.revision !== saved.revision) {
        saved = await putDraft(edited);
      }
      const address = previewAddress(saved);
      if (tab && address) tab.location.href = address;
      else tab?.close();
      setMessage('This draft is open at its own address. Your live site has not changed.');
    });
  };
  // Every size of this page, as saved (unsaved edits are saved first), onto the chosen space's board for review.
  const putOnBoard = async () => {
    const space = spaces.find(row => row.space_id === boardSpace);
    if (!space || !source || !selected || !projectAssembly) return;
    setMessage('');
    try {
      let saved = draft;
      if (visual.current?.hasUnsavedChanges()) {
        const edited = currentEdit();
        if (edited) {
          saved = await putDraft(edited);
          await reloadProjectAssembly(selected);
        }
      }
      const route = editorPage?.route ?? '/';
      await putSizesOnBoard({ space, name: `${siteName} · ${pageName(route)}${saved ? ' (draft)' : ''}`, onProgress: setMessage,
        drawAt: width => `${url(selected)}/picture?width=${width}&route=${encodeURIComponent(route)}` });
      setMessage(`Every size is on the ${space.title} board.`);
    } catch (error) {
      setMessage(errorWords(error, 'The sizes could not be put on the board.'));
      throw error;
    }
  };
  const readIndexedFile = async (id: string, path: string, current?: Source | null, knownRows = indexedFiles, peerName?: string) => {
    const selection = ++indexedRead.current;
    const siteSelection = siteRead.current;
    const isCurrent = () => selectedSite.current === id && siteSelection === siteRead.current && selection === indexedRead.current;
    const loaded = await readJson<IndexedFile>(`${url(id)}/file?path=${encodeURIComponent(path)}`)
      .catch(error => { if (!isCurrent()) return null; throw error; });
    if (!loaded || !isCurrent()) return;
    const loadedFiles: Record<string, string> = { [path]: loaded.content };
    if (isHtmlFile(path) && typeof DOMParser !== 'undefined') {
      const document = new DOMParser().parseFromString(loaded.content, 'text/html');
      const publicSiteOrigin = new URL((current ?? source)?.public_url ?? window.location.origin).origin;
      const localStyles = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')]
        .flatMap(link => {
          try {
            const assetUrl = new URL(link.getAttribute('href') ?? '', new URL(routeForIndexedFile(path), publicSiteOrigin));
            const assetPath = decodeURIComponent(assetUrl.pathname).replace(/^\/+/, '');
            return assetUrl.origin === publicSiteOrigin && assetPath && assetPath !== path ? [assetPath] : [];
          } catch { return []; }
        }).slice(0, 12);
      for (const assetPath of localStyles) {
        if (assetPath === path) continue;
        try {
          const asset = await readJson<IndexedFile>(`${url(id)}/file?path=${encodeURIComponent(assetPath)}`);
          if (!isCurrent()) return;
          if (typeof asset.content === 'string') loadedFiles[assetPath] = asset.content;
        } catch { /* The site can reference an absent stylesheet; its page still opens. */ }
      }
    }
    if (!isCurrent()) return;
    const held = indexedState.current;
    const hasEdits = Boolean(held.working && (Object.entries(held.working.files).some(([filePath, value]) =>
      typeof value === 'string' && value !== held.indexedContents[filePath])
      || JSON.stringify(held.working.placed_capabilities ?? []) !== JSON.stringify(held.source?.placed_capabilities ?? [])));
    // A collaborator's read cannot replace edits made here while its file or styles were loading, or advance the
    // saved revision underneath them. Ordinary file choices still keep the existing held-edit reconciliation.
    if (peerName && (peerState.current.busy || hasEdits || visual.current?.hasUnsavedChanges())) {
      if (peerState.current.busy) pendingPeer.current = { site: id, name: peerName };
      else setMessage(`${peerName} changed this file while you were editing. Your edits are kept here.`);
      return;
    }
    // Keep the saved baseline and its revision pair while edits are held. A later
    // read must not authorize overwriting a draft changed by another editor.
    const filesToTake = Object.fromEntries(Object.entries(loadedFiles).filter(([filePath]) =>
      !hasEdits || !Object.hasOwn(held.indexedContents, filePath)));
    setIndexedSelectedPath(path); setIndexedLoaded(loaded);
    setIndexedContents(rows => ({ ...rows, ...filesToTake }));
    if (isHtmlFile(path)) setSelectedPage(path);
    setWorking(base => {
      const selectedSource = base ?? current;
      return selectedSource ? { ...selectedSource, revision: hasEdits ? selectedSource.revision : loaded.revision,
        placed_capabilities: hasEdits ? selectedSource.placed_capabilities : loaded.placed_capabilities ?? selectedSource.placed_capabilities,
        files: { ...selectedSource.files, ...filesToTake } } : base;
    });
    if (!hasEdits) {
      setSource(base => base ? { ...base, revision: loaded.revision,
        placed_capabilities: loaded.placed_capabilities ?? base.placed_capabilities } : base);
      const draftBase = current ?? held.source;
      setDraft(loaded.draft_revision && draftBase ? { ...draftBase,
        placed_capabilities: loaded.placed_capabilities ?? draftBase.placed_capabilities,
        revision: loaded.draft_revision } : null);
    }
    return loaded;
  };
  const loadIndexedFiles = async (id: string, append = false, current?: Source | null) => {
    const selection = siteRead.current;
    const isCurrent = () => selectedSite.current === id && selection === siteRead.current;
    setIndexedFilesStatus('loading');
    try {
      const cursor = append ? indexedCursor : null;
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const result = await readJson<{ rows: IndexedFileRow[]; cursor: string | null }>(`${url(id)}/files?${query}`);
      if (!isCurrent()) return;
      setIndexedFiles(rows => append ? [...rows, ...result.rows] : result.rows);
      setIndexedCursor(result.cursor ?? null); setIndexedMore(Boolean(result.cursor)); setIndexedFilesStatus('ready');
      if (!append) await readIndexedFile(id, 'index.html', current, result.rows);
    } catch (error) { if (isCurrent()) { setIndexedFilesStatus('failed'); setMessage(errorWords(error, 'The site files could not load.')); } }
  };
  // One of this person's own Trillion screens, drawn signed in at every size, onto the chosen board beside their sites.
  const putScreenOnBoard = async () => {
    const space = spaces.find(row => row.space_id === boardSpace);
    const screen = screens.find(row => row.id === screenId);
    if (!space || !screen) return;
    setMessage('');
    try {
      await putSizesOnBoard({ space, name: screen.label, onProgress: setMessage,
        drawAt: width => `/work/api/screen-picture?path=${encodeURIComponent(screen.route_paths[0])}&width=${width}` });
      setMessage(`${screen.label} is on the ${space.title} board at every size.`);
    } catch (error) {
      setMessage(errorWords(error, 'The screen could not be put on the board.'));
      throw error;
    }
  };
  const publish = () => act(async () => {
    if (!source || !selected || (!draft && !indexedSource)) return;
    if (indexedSource) {
      const saved = await saveIndexedFiles();
      await readJson(`${url(selected)}/publish`, { method: 'POST', body: JSON.stringify({ expected_revision: saved?.revision ?? source.revision }) });
      await reload(selected); setMessage('Your changes are live at the same link.');
      return;
    }
    if (!projectAssembly || assemblyStatus !== 'ready') throw new Error('The saved site sources are still loading. Try again when they appear.');
    const edited = currentEdit();
    if (!edited) return;
    if (withAssemblyEditorFiles(edited, projectAssembly).revision !== draft.revision) {
      if (!await putDraft(edited)) throw new Error('The latest page edit could not be saved.');
      await reloadProjectAssembly(selected);
    }
    await readJson(`${url(selected)}/publish`, { method: 'POST', body: JSON.stringify({ expected_revision: source.revision }) });
    await reload(selected); setMessage('Your changes are live at the same link.');
  });
  const restore = async (revision: string) => {
    if (!source || !selected || busy) return;
    setBusy(true); setMessage('');
    try {
      await readJson(`${url(selected)}/restore`, { method: 'POST', body: JSON.stringify({ revision, expected_revision: source.revision }) });
      await reload(selected); setMessage('The earlier version is live at the same link.');
    } catch (error) {
      setMessage(errorWords(error, 'This version could not be restored.'));
      throw error;
    } finally { setBusy(false); }
  };
  // An earlier version put back as the draft (src/public-app-host.mjs restore-draft); the live app stays until Publish.
  const restoreAsDraft = async (revision: string) => {
    if (!source || !selected || busy) return;
    setBusy(true); setMessage('');
    try {
      const answer = await readJson<{ warnings?: { said: string }[] }>(`${url(selected)}/restore-draft`, { method: 'POST', body: JSON.stringify({ revision, expected_revision: source.revision }) });
      await reload(selected);
      setMessage(['The earlier version is in your draft; the live app is unchanged until you publish.', ...(answer.warnings ?? []).map(warning => warning.said)].join(' '));
    } catch (error) {
      setMessage(errorWords(error, 'This version could not be put in the draft.'));
      throw error;
    } finally { setBusy(false); }
  };
  const pictureOfVersion = async (revision: string) => {
    if (!selected) return null;
    const drawn = await readJson<{ status: string; image_base64?: string }>(`${url(selected)}/picture?revision=${encodeURIComponent(revision)}&width=640`);
    return drawn.status === 'ready' && drawn.image_base64 ? { src: `data:image/png;base64,${drawn.image_base64}` } : null;
  };
  type ImportSession = { import_id: string; session_id: string; revision: number; file_count: number; files: NonNullable<Imported['files_index']>; status?: string };
  const appendImportBatch = async (session: ImportSession, entries: { path: string; content: string }[]): Promise<ImportSession> => {
    const files = entries.length === 1 ? entries[0] : { entries };
    const added = await readJson<Omit<ImportSession, 'import_id' | 'session_id'>>(
      `/work/api/public-app/file-imports/${session.import_id}/${session.session_id}/files`, {
        method: 'POST', body: JSON.stringify({ expected_revision: session.revision, ...files }),
      });
    return { ...session, ...added };
  };
  const importFolder = (files: File[]) => act(async () => {
    let session: ImportSession | null = null;
    let pending: { path: string; content: string }[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!session || !pending.length) return;
      session = await appendImportBatch(session, pending);
      pending = [];
      pendingBytes = 0;
      setMessage(`Reading ${session.file_count} files`);
    };
    let summary: { page_count: number; file_count: number; bytes: number; problems: string[]; warnings: string[]; can_publish: boolean } | null = null;
    let previewFiles: Record<string, string> = {};
    for await (const event of streamPublicAppFolder(files)) {
      if (event.kind === 'file') {
        if (!session) {
          if (event.path !== 'index.html') throw new Error('The site import did not start with index.html.');
          session = await readJson<ImportSession>('/work/api/public-app/file-imports', {
            method: 'POST', body: JSON.stringify({ index_content: event.content }),
          });
        } else {
          pending.push({ path: event.path, content: event.content });
          pendingBytes += event.content.length * 4;
          if (pending.length >= 16 || pendingBytes >= 3_000_000) await flush();
        }
        if (session) setMessage(`Reading ${session.file_count} files`);
      } else if (event.kind === 'summary') {
        await flush();
        summary = event;
        previewFiles = event.files;
      }
    }
    if (!summary) throw new Error('The selected folder could not be read.');
    if (session && summary.can_publish) {
      const finalized = await readJson<{ file_import: NonNullable<Imported['file_import']>; files: { file_count: number; page_count: number; byte_count: number } }>(
        `/work/api/public-app/file-imports/${session.import_id}/${session.session_id}/finalize`, {
          method: 'POST', body: JSON.stringify({ expected_revision: session.revision, expected_file_count: summary.file_count }),
        });
      setImported({ files: previewFiles, files_index: session.files, file_import: finalized.file_import,
        pages: Object.keys(previewFiles).filter(path => path.endsWith('.html')), page_count: finalized.files.page_count,
        bytes: finalized.files.byte_count, problems: summary.problems, warnings: summary.warnings, can_publish: summary.can_publish });
    } else {
      setImported({ files: previewFiles, pages: Object.keys(previewFiles).filter(path => path.endsWith('.html')),
        bytes: summary.bytes, page_count: summary.page_count, problems: summary.problems, warnings: summary.warnings, can_publish: false });
    }
    const folder = files[0]?.webkitRelativePath?.split('/')[0] || 'my-site';
    setImportName(folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80));
    setMessage(summary.can_publish ? `${summary.page_count} pages and ${summary.file_count} files can be imported. Check the behavior notes before publishing.` : 'This folder needs changes before it can run as a public app.');
  });
  const importSiteAddress = () => act(async () => {
    const sourceUrl = checkedPublicSiteUrl(siteAddress);
    const copy = await resumeCopiedSite({ sourceUrl, storage: localHints, onProgress: setMessage, returnBatches: true,
      // A run answers once it finished: its result and the files it kept, in the shape the continuation reads. Only a
      // copy an older Trillion started holds a task to ask about, and that task has no owner now.
      start: async (input, request_key) => {
        const ran = await runWorkshopTool('tool:copy-a-site', input, request_key);
        return { output: { result: ran.result, files: ran.files } };
      },
      poll: () => Promise.reject(new Error('This copy was started by an earlier version of Trillion. Copy the address again from the start.')),
      readFile: identity => readFileJson<{ files: Record<string, string> }>(identity),
    });
    if (copy.paused) {
      setMessage('Copy paused after eight batches. Copy this address again to continue.');
      return;
    }
    const checkpointKey = `trillion:site-copy:${new URL(sourceUrl).href}`;
    let checkpoint: Record<string, unknown> = {};
    try { checkpoint = JSON.parse(localHints.getItem(checkpointKey) ?? '{}'); } catch { /* The copied batches remain the source of truth. */ }
    const savedImport = checkpoint.import_session as { import_id?: string; session_id?: string } | undefined;
    let session: ImportSession | null = savedImport?.import_id && savedImport.session_id
      ? { ...await readJson<Omit<ImportSession, 'import_id'>>(`/work/api/public-app/file-imports/${savedImport.import_id}/${savedImport.session_id}`), import_id: savedImport.import_id }
      : null;
    const keepImport = () => {
      const serialized = JSON.stringify({ ...checkpoint, source_url: sourceUrl, batches: copy.batches,
        import_session: session ? { import_id: session.import_id, session_id: session.session_id } : undefined });
      localHints.setItem(checkpointKey, serialized);
      if (localHints.getItem(checkpointKey) !== serialized) throw new Error('The site import could not save its resume point in this browser. Try this address again to continue.');
    };
    let pending: { path: string; content: string }[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!session || !pending.length) return;
      session = await appendImportBatch(session, pending);
      pending = [];
      pendingBytes = 0;
      setMessage(`Reading ${session.file_count} files`);
    };
    let summary: { files: Record<string, string>; pages: string[]; file_count: number; page_count: number; bytes: number; problems: string[]; warnings: string[]; can_publish: boolean; source_url: string; skipped: { address: string; reason: string }[]; source_file_path: string } | null = null;
    for await (const event of streamCopiedPublicSite({ batches: copy.batches, sourceUrl, readFile: identity => readFileJson<{ files: Record<string, string> }>(identity), skipped: copy.skipped })) {
      if (event.kind === 'file') {
        if (!session) {
          if (event.path !== 'index.html') throw new Error('The site import did not start with index.html.');
          session = await readJson<typeof session & {}>('/work/api/public-app/file-imports', {
            method: 'POST', body: JSON.stringify({ index_content: event.content }),
          });
          keepImport();
        } else if (session.status !== 'finalized') {
          pending.push({ path: event.path, content: event.content });
          pendingBytes += event.content.length * 4;
          if (pending.length >= 16 || pendingBytes >= 3_000_000) await flush();
        }
        setMessage(`Reading ${session.file_count} files`);
      } else { await flush(); summary = event; }
    }
    if (!summary) throw new Error('The copied site could not be imported.');
    if (session && summary.can_publish) {
      const finalized = await readJson<{ file_import: NonNullable<Imported['file_import']>; files: { file_count: number; page_count: number; byte_count: number } }>(
        `/work/api/public-app/file-imports/${session.import_id}/${session.session_id}/finalize`, {
          method: 'POST', body: JSON.stringify({ expected_revision: session.revision, expected_file_count: summary.file_count }),
        });
      setImported({ ...summary, files_index: session.files, file_import: finalized.file_import, source_url: summary.source_url,
        skipped: summary.skipped, source_file_path: summary.source_file_path, page_count: finalized.files.page_count,
        bytes: finalized.files.byte_count, can_publish: summary.can_publish });
    } else {
      setImported({ ...summary, source_url: summary.source_url, skipped: summary.skipped,
        source_file_path: summary.source_file_path, page_count: summary.page_count, can_publish: false });
    }
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
    setImportName(host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'my-site');
    const hasUncopied = !copy.complete || Boolean(summary?.skipped.length);
    setMessage(summary.can_publish ? `${summary.pages.length} pages copied from ${host}.${hasUncopied ? ' Some pages or files stayed on the original site; review the findings before publishing.' : ''}` : 'This site needs changes before it can run as a public app.');
  });
  const createImported = () => act(async () => {
    if (!imported?.can_publish) return;
    let sharedSpace: BoardSpace | null = null;
    if (workWith !== 'private') {
      if (!workWith.startsWith('space:') || !spacesRead) {
        throw new Error('Trillion could not confirm that company or pursuit. Choose Just me or reload the company list before importing.');
      }
      const spaceId = workWith.slice('space:'.length);
      const current = await readJson<{ spaces: BoardSpace[] }>('/work/api/spaces');
      setSpaces(current.spaces);
      sharedSpace = current.spaces.find(space => space.space_id === spaceId) ?? null;
      if (!sharedSpace) {
        setWorkWith(`unavailable:${spaceId}`);
        throw new Error('That company or pursuit is no longer available. Choose another one before importing.');
      }
    }
    const project = appProjectFromImportedSite({ id: importName, name: sentence(importName), imported });
    let uploaded: Record<string, FileRef> = {};
    if (!imported.site_file_identity && !imported.file_import) {
      const entries = Object.entries(imported.files);
      let cursor = 0;
      let finished = 0;
      await Promise.all(Array.from({ length: Math.min(5, entries.length) }, async () => {
        while (cursor < entries.length) {
          const [path, content] = entries[cursor++];
          uploaded[path] = await readJson<FileRef>('/work/api/public-app/files', {
            method: 'POST', body: JSON.stringify({ path, content }),
          });
          setMessage(`Uploaded ${++finished} of ${entries.length} files.`);
        }
      }));
    }
    const published = await readJson<{ id: string; version: string }>('/work/api/public-app/definitions', {
      method: 'POST', body: JSON.stringify(publicAppDefinitionFromImportedProject(project, imported, uploaded)),
    });
    const installed = await readJson<Installation>('/work/api/public-app/installations', {
      method: 'POST', body: JSON.stringify({ app_id: published.id, version: published.version,
        context: sharedSpace ? { kind: 'space', id: sharedSpace.space_id } : 'private', name: importName }),
    });
    setInstallations(rows => [...rows, { ...installed, ...(sharedSpace ? { space_title: sharedSpace.title } : {}), custom_domains: [] }]);
    setSelected(installed.installation_id);
    if (imported.source_url) clearCopiedSiteCheckpoint(localHints, imported.source_url);
    setImported(null);
    setMessage(sharedSpace
      ? `Your site is public. Members with access to ${sharedSpace.title} can edit it in Sites.`
      : 'Your site is installed. Open its live page to check the result.');
  });
  const addImportedSource = () => act(async () => {
    if (!selected || !selectedInstallation || selectedInstallation.status !== 'active' || !imported?.can_publish || !projectAssembly) return;
    const project = appProjectFromImportedSite({ id: importName, name: sentence(importName), imported });
    const key = sourceProjectKey(project.name, projectAssembly.sources);
    const next = addCheckedSource(projectAssembly, key, project);
    const uploaded: Record<string, FileRef> = {};
    if (!imported.file_import) {
      const entries = Object.entries(imported.files);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(5, entries.length) }, async () => {
        while (cursor < entries.length) {
          const [path, content] = entries[cursor++];
          uploaded[path] = await readJson<FileRef>('/work/api/public-app/files', {
            method: 'POST', body: JSON.stringify({ path, content }),
          });
        }
      }));
    }
    const source_files = imported.file_import ? projectAssembly.source_files
      : { ...projectAssembly.source_files, [key]: uploaded };
    const saved = await readJson<ProjectAssembly>(`${url(selected)}/project/assembly`, {
      method: 'PUT', body: JSON.stringify({ expected_revision: projectAssembly.revision,
        expected_source_files_revision: projectAssembly.source_files_revision, project: next, source_files }),
    });
    setProjectAssembly(saved);
    setWorking(current => current ? withAssemblyEditorFiles(current, saved) : current);
    if (imported.source_url) clearCopiedSiteCheckpoint(localHints, imported.source_url);
    setImported(null);
    setMessage(`${project.name} was saved as a checked web source. The live site has not changed.`);
  });
  const addPinnedRepositorySource = async (projectId: string) => {
    if (!selected || !selectedInstallation || selectedInstallation.status !== 'active' || !projectAssembly) return;
    const connected = await readJson<{ id: string; provider: 'github'; owner: string; repo: string; branch: string;
      commit: string; current_commit: string; stale: boolean }>(sourceProjectUrl(projectId));
    if (connected.stale || connected.commit !== connected.current_commit) {
      throw new Error('This GitHub branch changed. Refresh the connection and try again.');
    }
    const response = await readJson<{ status: string; reason?: string; snapshot?: { project_id: string; owner: string;
      repo: string; branch: string; commit: string; files: Record<string, string> };
      hosted?: { kind: 'running-web-origin'; project_id: string; owner: string; repo: string;
        branch: string; commit: string; url: string; routes?: string[] } }>(
      `${sourceProjectUrl(projectId)}/site-snapshot?expected_commit=${encodeURIComponent(connected.commit)}`);
    if (response.status !== 'ready' && response.status !== 'hosted') {
      throw new Error(response.reason ?? 'This repository does not have a hostable web page.');
    }
    const base = connected.repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'github-site';
    const snapshot = response.hosted ?? response.snapshot;
    if (!snapshot) throw new Error('The connected repository did not return a checked page.');
    const project = appProjectFromPinnedRepository({ id: `github-${base}-web`, name: sentence(connected.repo),
      project: connected, snapshot });
    const key = sourceProjectKey(project.name, projectAssembly.sources);
    const next = addCheckedSource(projectAssembly, key, project);
    const entries = Object.entries(response.snapshot?.files ?? {});
    const uploaded: Record<string, FileRef> = {};
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(5, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [path, content] = entries[cursor++];
        uploaded[path] = await readJson<FileRef>('/work/api/public-app/files', {
          method: 'POST', body: JSON.stringify({ path, content }),
        });
      }
    }));
    const source_files = { ...projectAssembly.source_files, [key]: uploaded };
    const saved = await readJson<ProjectAssembly>(`${url(selected)}/project/assembly`, {
      method: 'PUT', body: JSON.stringify({ expected_revision: projectAssembly.revision,
        expected_source_files_revision: projectAssembly.source_files_revision, project: next, source_files }),
    });
    setProjectAssembly(saved);
    return response.status === 'hosted' ? 'hosted' as const : 'files' as const;
  };
  const connectAction = (action: VisitorAction) => act(async () => {
    if (!working || !visual.current) return;
    const id = working.placed_capabilities?.find(row => row.page_path === placementPagePath && row.capability.kind === 'visitor-action' && row.capability.id === action.id)?.id
      ?? `action-${crypto.randomUUID()}`;
    if (!visual.current.bindSelectedForm(`/capabilities/${id}/actions`)) throw new Error('Select a form on the page before connecting this action.');
    const edited = currentEdit();
    if (!edited) return;
    const placed_capabilities = [...(edited.placed_capabilities ?? []).filter((row: Placement) => row.id !== id), {
      id, page_path: placementPagePath ?? 'index.html', access: 'public' as const,
      capability: { kind: 'visitor-action', id: action.id, version: publicAppActionVersion(action) },
    }];
    setWorking(indexedSource ? { ...edited, placed_capabilities }
      : { ...working, ...checkedPublicAppEditorSource({ ...edited, placed_capabilities }) });
    setMessage('The selected form is connected. Save the draft, then publish to make it live.');
  });
  const placePublishedCapability = (item: CatalogEntry) => act(async () => {
    if (!working || !visual.current || !item.version || !item.capabilityKind) return;
    const existing = working.placed_capabilities?.find(row => row.page_path === placementPagePath && row.capability.kind === item.capabilityKind && row.capability.id === item.id);
    const id = existing?.id
      ?? `placed-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    if (!visual.current.placeCapability(id, item.label)) throw new Error('The page is still opening. Try again.');
    const edited = currentEdit();
    if (!edited) return;
    const operation = item.operations?.includes('run') ? 'run' as const : undefined;
    const placed_capabilities = [...(edited.placed_capabilities ?? []).filter((row: Placement) => row.id !== id), {
      id, page_path: placementPagePath ?? 'index.html', access: 'public' as const,
      capability: { kind: item.capabilityKind, id: item.id, version: item.version, ...(operation ? { operation } : {}) },
      presentation: existing?.presentation ?? { title: item.label, description: item.detail || item.label, style: 'card' as const },
    }];
    setWorking(indexedSource ? { ...edited, placed_capabilities }
      : { ...working, ...checkedPublicAppEditorSource({ ...edited, placed_capabilities }) });
    setSelectedCardId(id);
    setMessage('This item is on the page. Set its public words and appearance, then save and publish.');
  });

  const applyCardPresentation = (presentation: PublicCardPresentation, operation: 'open' | 'run') => act(async () => {
    if (!working || !selectedCardId) return;
    const edited = currentEdit();
    if (!edited) return;
    const placed_capabilities = edited.placed_capabilities?.map((row: Placement) => row.id === selectedCardId ? {
      ...row, presentation, capability: { ...row.capability, operation },
    } : row);
    if (!placed_capabilities?.some((row: Placement) => row.id === selectedCardId)) throw new Error('This card is no longer on the page.');
    setWorking(indexedSource ? { ...edited, placed_capabilities }
      : { ...working, ...checkedPublicAppEditorSource({ ...edited, placed_capabilities }) });
    setMessage('The public card settings are in this draft. Save and publish to make them live.');
  });

  const askAiToEditSelection = () => act(async () => {
    if (!source || !selected || !working || !selection || !editRequest.trim()) return;
    if (!editorPage || selection.page_path !== editorPage.html_path || selection.route !== editorPage.route || selection.revision !== working.revision) throw new Error('Select the element again before sending this edit.');
    const edited = currentEdit();
    if (!edited) return;
    const html = edited.files[editorPage.html_path];
    if (typeof html !== 'string') throw new Error('The selected page is unavailable.');
    const matches = new DOMParser().parseFromString(html, 'text/html').querySelectorAll(selection.selector);
    if (matches.length !== 1 || matches[0].tagName.toLowerCase() !== selection.tag) throw new Error('This element changed while you were editing. Select it again.');
    const saved = await putDraft(edited);
    if (!saved) throw new Error('The edited page could not be saved.');
    await reloadProjectAssembly(selected);
    setSelection(null);
    const target = { ...selection, revision: saved.revision };
    const answer = await sendQueuedJob({ job_id: 'edit-public-app-selection', context: {
      installation_id: selected, revision: saved.revision, selection: JSON.stringify(target), request: editRequest.trim(),
    }, press_key: crypto.randomUUID() });
    setEditRequest('');
    setMessage(answer.said || 'Your AI has the selected element and your request.');
  });

  const selectedInstallation = installations.find(item => item.installation_id === selected);
  const sites = siteChoices(installations);
  const siteName = [...sites.live, ...sites.ended].find(site => site.id === selected)?.name ?? 'Choose a site';
  const liveAt = selectedInstallation?.custom_domains.find(domain => domain.status === 'active')?.url ?? selectedInstallation?.public_url;
  const liveHost = liveAt ? new URL(liveAt).host : '';
  const active = selectedInstallation?.status === 'active';
  return <Container className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden p-4">
    {/* One bar for the site: which site, its views, where it lives, and the two things done to a draft (see it, make it live). */}
    <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
      {installations.length ? <Select value={selected} disabled={busy} onValueChange={value => { if (typeof value === 'string') { setMessage(''); setSelected(value); } }}>
        <SelectTrigger aria-label="Site" className="min-w-0 max-w-full sm:max-w-[14rem]"><SelectValue>{siteName}</SelectValue></SelectTrigger>
        <SelectPopup>
          {sites.live.length ? <SelectGroup><SelectGroupLabel>Live</SelectGroupLabel>{sites.live.map(site => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}</SelectGroup> : null}
          {sites.ended.length ? <SelectGroup><SelectGroupLabel>Offline</SelectGroupLabel>{sites.ended.map(site => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}</SelectGroup> : null}
        </SelectPopup>
      </Select> : <Text variant="heading-sm">Sites</Text>}
      {selectedInstallation && !active ? <Text variant="caption" className="text-[var(--text-muted)]">Offline</Text> : null}
      <SegmentedControl ariaLabel="Site views" value={pane} onValueChange={setPane} items={[{ id: 'design', label: 'Design' }, { id: 'activity', label: 'Visitors' }, { id: 'history', label: 'Versions' }, { id: 'settings', label: 'Settings' }]} />
      {source && active && liveAt && publishedPagePath ? <Button size="sm" variant="ghost" aria-label={`Open live site ${liveHost}`} title="Open the live site" className="min-w-0 max-w-full truncate" onClick={() => window.open(new URL(publishedPagePath, liveAt).href, '_blank', 'noopener,noreferrer')}>{liveHost} ↗</Button> : null}
      {source && pane === 'design' && active ? <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap" className="ml-auto min-w-0">
        {spaces.length > 1 ? <Select value={boardSpace} onValueChange={value => { if (typeof value === 'string') setBoardSpace(value); }}>
          <SelectTrigger aria-label="Board to review on" size="sm" className="min-w-0 max-w-[10rem]"><SelectValue>{spaces.find(row => row.space_id === boardSpace)?.title ?? 'Choose a pursuit'}</SelectValue></SelectTrigger>
          <SelectPopup>{spaces.map(row => <SelectItem key={row.space_id} value={row.space_id}>{row.title}</SelectItem>)}</SelectPopup>
        </Select> : null}
      {spaces.length ? <Button size="sm" variant="ghost" disabled={busy || assemblyStatus !== 'ready' || !projectAssembly || !boardSpace} title={`Every size of this page on ${spaces.find(row => row.space_id === boardSpace)?.title ?? 'a space'}'s board`} pendingLabel="Putting on the board" doneLabel="On the board" errorLabel="Try again" data-tour="put-sizes-on-board" onClick={putOnBoard}>Review on board</Button> : null}
        {!indexedSource && previewAddress(working) ? <Button size="sm" variant="secondary" disabled={busy || assemblyStatus !== 'ready' || !projectAssembly || !routeInCanvas || (editorPage?.visual_supported && !visualReady)} title="Open this draft at its own address; the live site does not change" onClick={previewDraft}>Preview</Button> : null}
        {indexedSource && previewAddress(draft) ? <Button size="sm" variant="secondary" disabled={busy} title="Open the saved draft at its own address; the live site does not change" onClick={() => window.open(previewAddress(draft)!, '_blank', 'noopener,noreferrer')}>Preview</Button> : null}
        <Button size="sm" variant="secondary" disabled={busy || assemblyStatus !== 'ready' || (!projectAssembly && !indexedSource) || (editorPage?.visual_supported && !visualReady) || (indexedSource && !indexedLoaded)} onClick={() => save()}>{indexedSource ? 'Save file' : 'Save draft'}</Button>
        <Button size="sm" variant="primary" disabled={busy || assemblyStatus !== 'ready' || !projectAssembly || (!draft && !indexedSource) || (editorPage?.visual_supported && !visualReady)} pendingLabel="Publishing" doneLabel="Live" errorLabel="Try again" onClick={() => publish()}>Publish</Button>
      </Container> : null}
    </Container>
    {pane === 'design' && indexedSource ? <Container layout="horizontal" gap="sm" alignItems="end" wrap="wrap" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3" aria-label="Site files">
      <Select value={indexedSelectedPath && isHtmlFile(indexedSelectedPath) ? indexedSelectedPath : ''} disabled={busy} onValueChange={value => { if (typeof value === 'string') chooseIndexedFile(value); }}>
        <SelectTrigger aria-label="Page" className="min-w-0 flex-1"><SelectValue>{indexedFiles.find(row => row.path === indexedSelectedPath && isHtmlFile(row.path)) ? `${pageName(routeForIndexedFile(indexedSelectedPath))} · ${routeForIndexedFile(indexedSelectedPath)}` : 'Choose a page'}</SelectValue></SelectTrigger>
        <SelectPopup>{indexedFiles.filter(row => isHtmlFile(row.path)).map(row => <SelectItem key={row.path} value={row.path}>{`${pageName(routeForIndexedFile(row.path))} · ${routeForIndexedFile(row.path)}`}</SelectItem>)}</SelectPopup>
      </Select>
      <Select value={indexedSelectedPath && !isHtmlFile(indexedSelectedPath) ? indexedSelectedPath : ''} disabled={busy} onValueChange={value => { if (typeof value === 'string') chooseIndexedFile(value); }}>
        <SelectTrigger aria-label="Asset" className="min-w-0 flex-1"><SelectValue>{indexedFiles.find(row => row.path === indexedSelectedPath && !isHtmlFile(row.path))?.path ?? 'Choose an asset'}</SelectValue></SelectTrigger>
        <SelectPopup>{indexedFiles.filter(row => !isHtmlFile(row.path)).map(row => <SelectItem key={row.path} value={row.path}>{row.path}</SelectItem>)}</SelectPopup>
      </Select>
      {indexedFilesStatus === 'loading' ? <LoadingMark size="sm" label="Loading the file list" /> : null}
      {indexedFilesStatus === 'failed' ? <Button size="sm" variant="secondary" onClick={() => loadIndexedFiles(selected)}>Load files again</Button> : null}
      {indexedMore ? <Button size="sm" variant="secondary" disabled={indexedFilesStatus === 'loading'} onClick={() => loadIndexedFiles(selected, true)}>Load more files</Button> : null}
      {indexedFilesStatus === 'ready' ? <Text variant="caption">{indexedFiles.length} files loaded</Text> : null}
    </Container> : null}
    {pane === 'design' && indexedSource && indexedLoaded && !isHtmlFile(indexedLoaded.path) ? <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3" aria-label="Edit site asset">
      <Text variant="heading-xs">{indexedLoaded.path}</Text>
      {indexedBusy ? <LoadingMark size="sm" label="Loading the file" /> : null}
      {/^text\/|json|javascript|xml|svg|css/i.test(indexedFiles.find(row => row.path === indexedLoaded.path)?.media_type ?? '')
        ? <Textarea label="File contents" disabled={busy} value={typeof working?.files[indexedLoaded.path] === 'string' ? working.files[indexedLoaded.path] as string : indexedLoaded.content} onChange={event => {
          const content = event.currentTarget.value;
          setWorking(current => current ? { ...current, files: { ...current.files, [indexedLoaded.path]: content } } : current);
        }} />
        : <Text variant="body">This asset is available to the site, but it cannot be edited as text.</Text>}
    </Container> : null}
    {source && assemblyStatus === 'loading' ? <Text variant="caption">Checking saved site sources before changes can be saved…</Text> : null}
    {source && assemblyStatus === 'failed' ? <Container layout="horizontal" gap="sm" alignItems="center"><Text variant="caption">The saved site sources could not load.</Text><Button size="sm" variant="secondary" onClick={() => { setAssemblyStatus('loading'); void reloadProjectAssembly(selected).then(assembly => { setWorking(working => working && !visual.current?.hasUnsavedChanges() ? withAssemblyEditorFiles(working, assembly) : working); setAssemblyStatus('ready'); }).catch(() => setAssemblyStatus('failed')); }}>Load sources again</Button></Container> : null}
    {pane === 'settings' ? <Container layout="vertical" gap="md" className="min-w-0">
    {projectAssembly && selected === selectedInstallation?.installation_id ? <Text variant="caption" className="text-[var(--text-muted)]">{projectAssembly.sources.length} sources · {projectAssembly.pages.length} routes</Text> : null}
    {selectedInstallation?.can_manage_commerce && selectedInstallation.status === 'active' ? <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
      <Text variant="heading-xs">Shop</Text>
      <Container layout="vertical" gap="sm" padding="md">
        <Text variant="body">Products, prices, stock, checkout and orders come from your Shopify store.</Text>
        {!commerce ? <Text variant="body">Checking the shop connection…</Text> : commerce.connection ? <Text variant="body">Connected: {commerce.available_shops.find(row => row.connection_id === commerce.connection?.connection_id)?.label ?? 'Shopify store'}</Text> : <Text variant="body">No merchant store is connected to this site.</Text>}
        {!commerce ? null : commerce.available_shops.length ? <Container layout="horizontal" gap="sm" alignItems="end" wrap="wrap">
          <Select value={shopChoice} onValueChange={value => { if (typeof value === 'string') setShopChoice(value); }}>
            <SelectTrigger aria-label="Merchant store" className="min-w-0 max-w-sm"><SelectValue>{commerce.available_shops.find(row => row.connection_id === shopChoice)?.label ?? 'Choose a Shopify store'}</SelectValue></SelectTrigger>
            <SelectPopup>{commerce.available_shops.map(row => <SelectItem key={row.connection_id} value={row.connection_id}>{row.label}</SelectItem>)}</SelectPopup>
          </Select>
          <Button size="sm" variant="primary" disabled={busy || !shopChoice || shopChoice === commerce.connection?.connection_id} onClick={connectShop}>Use this store</Button>
          {commerce.connection ? <Button size="sm" variant="secondary" disabled={busy} onClick={disconnectShop}>Disconnect store</Button> : null}
        </Container> : <Button size="sm" variant="secondary" onClick={() => window.open('/connections?show_row=shopify', '_blank', 'noopener,noreferrer')}>Open Connections to add Shopify</Button>}
        {commerce?.connection ? <Container layout="vertical" gap="sm" className="min-w-0">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => loadOrders()}>Show recent orders</Button>
          {orders?.length === 0 ? <Text variant="body">No orders found in this store.</Text> : null}
          {orders?.map(order => <Container key={order.id} layout="vertical" gap="xs" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
            <Text variant="body">{order.name} · {order.payment_status} · {order.fulfillment_status}{order.total ? ` · ${order.total.amount} ${order.total.currencyCode}` : ''}</Text>
            <Text variant="caption">{order.items.map(item => `${item.quantity} × ${item.title}`).join(', ') || 'No items returned'}{order.more_items ? ' · More items in Shopify' : ''}</Text>
          </Container>)}
          {ordersCursor ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => loadOrders(ordersCursor)}>Load more orders</Button> : null}
        </Container> : null}
      </Container>
    </Container> : null}
    {selectedInstallation ? <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
      <Text variant="body" className="min-w-0 flex-1">{active ? 'This site is live.' : 'This site is offline.'}</Text>
      {active
        ? <Button size="sm" variant="secondary" disabled={busy} pendingLabel="Taking offline" doneLabel="Offline" errorLabel="Try again" onClick={() => setLive(false)}>Take offline</Button>
        : <Button size="sm" variant="primary" disabled={busy} pendingLabel="Putting back online" doneLabel="Online" errorLabel="Try again" onClick={() => setLive(true)}>Put back online</Button>}
    </Container> : null}
    {active && selectedInstallation?.ai_app_url ? <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
      <Container layout="vertical" gap="xs" className="min-w-0 flex-1">
        <Text variant="body">Use this site in ChatGPT, Claude and other AI apps: add this address as a connector.</Text>
        <Text variant="caption" breakAll>{selectedInstallation.ai_app_url}</Text>
      </Container>
      <Button size="sm" variant="secondary" doneLabel="Copied" errorLabel="Try again" onClick={async () => {
        if (!(await copyTextToClipboard(selectedInstallation.ai_app_url ?? ''))) throw new Error('This browser did not let Trillion copy it.');
      }}>Copy address</Button>
    </Container> : null}
    {selectedInstallation && (selectedInstallation.custom_domains.length || selectedInstallation.can_manage_domains) ? <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
      <Text variant="heading-xs">Address · {new URL(selectedInstallation.public_url).host}</Text>
      <Container layout="vertical" gap="sm" className="min-w-0">
      {selectedInstallation.domains_loaded === false && domainsStatus === 'loading' ? <Text variant="caption">Checking connected domains…</Text> : null}
      {selectedInstallation.domains_loaded === false && domainsStatus === 'failed' ? <Text variant="caption">Connected domains could not load. Select this site again to retry.</Text> : null}
      {selectedInstallation.can_manage_domains && selectedInstallation.status === 'active' && selectedInstallation.name ? <Container layout="horizontal" gap="sm" alignItems="end" wrap="wrap" className="min-w-0">
        <Input label="Site name" value={appName} onChange={event => setAppName(event.currentTarget.value.toLowerCase())} placeholder={selectedInstallation.name} hint={`Lowercase letters, numbers and hyphens. Today: ${new URL(selectedInstallation.public_url).host}`} className="min-w-0 flex-1" />
        <Button size="sm" variant="secondary" disabled={busy || !appName.trim() || appName.trim() === selectedInstallation.name} onClick={() => renameApp()}>Rename</Button>
      </Container> : null}
      {selectedInstallation.custom_domains.map(domain => <Container key={domain.host} layout="vertical" gap="xs" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
        <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
          <Text variant="body" breakAll className="min-w-0">{domain.host} · {domainState[domain.status]}{domain.provider_readback ? ` · Hosting last confirmed ${domain.provider_readback.status === 'attached' ? 'connected' : domain.provider_readback.status === 'absent' ? 'disconnected' : 'pending'}${domain.provider_checked_at ? ` on ${new Date(domain.provider_checked_at).toLocaleString()}` : ''}` : ''}</Text>
          {domain.status === 'active' ? <Button size="sm" variant="secondary" onClick={() => window.open(domain.url, '_blank', 'noopener,noreferrer')}>Open</Button> : null}
          {selectedInstallation.can_manage_domains && domain.status !== 'ended' && domain.status !== 'retiring' ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => retireDomain(domain.host)}>{domain.status === 'active' || domain.provider_readback?.status === 'attached' ? 'Disconnect' : 'Cancel connection'}</Button> : null}
          {domain.status === 'awaiting_dns' || domain.status === 'awaiting_attachment' ? selectedInstallation.can_manage_domains ? <Button size="sm" variant="primary" disabled={busy} onClick={() => activateDomain(domain.host)}>Verify and connect</Button> : null : null}
          {domain.status === 'retiring' && selectedInstallation.can_manage_domains ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => retireDomain(domain.host)}>Retry disconnect</Button> : null}
        </Container>
        {selectedInstallation.can_manage_domains && domain.address_record ? <Text variant="body" breakAll> CNAME · {domain.address_record.name} → {domain.address_record.value}</Text> : null}
        {selectedInstallation.can_manage_domains && domain.verification_record ? <Text variant="body" breakAll> TXT · {domain.verification_record.name} = {domain.verification_record.value}</Text> : null}
        {selectedInstallation.can_manage_domains ? domain.provider_readback?.dns_records?.map((record, index) => <Text key={`${record.type}:${record.name}:${index}`} variant="body" breakAll>{record.type} · {record.name} = {record.value}</Text>) : null}
      </Container>)}
      {selectedInstallation.can_manage_domains && selectedInstallation.status === 'active' ? <Container layout="horizontal" gap="sm" alignItems="end" wrap="wrap" className="min-w-0">
        <Input label="Domain you control" value={domainName} onChange={event => setDomainName(event.currentTarget.value)} placeholder="www.example.com" hint="Enter a hostname without https:// or a path." className="min-w-0 flex-1" />
        <Button size="sm" variant="primary" disabled={busy || !domainName.trim()} onClick={() => claimDomain()}>Start domain connection</Button>
      </Container> : null}
      </Container>
    </Container> : null}
    {selectedInstallation?.status === 'active' && projectAssembly ? <PublicAppAssemblyPanel assembly={projectAssembly} installationId={selected} liveUrl={liveAt} busy={busy} onSave={async project => {
      const saved = await readJson<ProjectAssembly>(`${url(selected)}/project/assembly`, {
        method: 'PUT', body: JSON.stringify({ expected_revision: projectAssembly.revision,
          expected_source_files_revision: projectAssembly.source_files_revision, project,
          source_files: Object.fromEntries(Object.entries(projectAssembly.source_files).filter(([key]) =>
            project.sources.some(source => source.key === key && source.targets.includes('web')))) }),
      });
      setProjectAssembly(saved);
    }} onAddRepository={addPinnedRepositorySource} onBuildNative={async (target, expectedRevision, outputKind) => readJson<{
      identity: string; name: string; target: 'ios' | 'macos'; signing: 'unsigned' | 'not-signed'; distribution: string; said: string;
    }>(`${url(selected)}/native-build`, {
      method: 'POST', body: JSON.stringify({ target, expected_revision: expectedRevision, output_kind: outputKind }),
    })} /> : null}
    <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
      <Text variant="heading-xs">Add a site</Text>
      <Container layout="vertical" gap="sm" padding="md">
        <Text variant="heading-xs">Import a site</Text>
        <Text variant="body">Copy a public site by HTTPS address, or choose a built site folder. An address copy keeps rendered pages, styles, images, and fonts, but removes scripts. A folder can include supported local scripts; inline scripts and outside resources may be blocked. The original sign-in, server actions, APIs, and native app code are not imported. An address copy may skip pages or files; review the findings below.</Text>
        <Container layout="vertical" gap="xs" className="min-w-0">
          <Select value={workWith} onValueChange={value => { if (typeof value === 'string') setWorkWith(value); }}>
            <SelectTrigger aria-label="Work with" className="min-w-0 max-w-full sm:max-w-[24rem]">
              <SelectValue>{workWith === 'private' ? 'Just me'
                : spaces.find(space => `space:${space.space_id}` === workWith)?.title
                  ?? (workWith.startsWith('requested:') ? 'Checking access…'
                    : workWith.startsWith('unavailable:') ? 'Company or pursuit unavailable' : 'Choose a company or pursuit')}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="private">Just me</SelectItem>
              {spaces.map(space => <SelectItem key={space.space_id} value={`space:${space.space_id}`}>{space.title}</SelectItem>)}
            </SelectPopup>
          </Select>
          <Text variant="caption">The published site is public either way. Choose a company or pursuit so members with editing access there can edit and publish this site.</Text>
          {spacesReadFailed ? <Text variant="caption">Your companies and pursuits could not be loaded. You can choose Just me, or reload Sites before choosing a shared company or pursuit.</Text> : null}
          {spacesRead && spaces.length === 0 ? <Text variant="caption">No company or pursuit is available to share this site with. You can still choose Just me.</Text> : null}
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="end" wrap="wrap" className="min-w-0">
          <Input label="Public site address" type="url" inputMode="url" placeholder="https://example.com" value={siteAddress} onChange={event => setSiteAddress(event.currentTarget.value)} className="min-w-0 flex-1" />
          <Button size="sm" variant="secondary" disabled={busy || !/^https:\/\//i.test(siteAddress.trim())} onClick={() => importSiteAddress()}>Copy site</Button>
        </Container>
        <Text variant="caption">Only public HTTPS pages are copied. Some pages or files may stay linked to the original site.</Text>
        <Text variant="caption">Or choose a built site folder with index.html.</Text>
        <FolderPicker label="Choose site folder" disabled={busy} onFiles={files => void importFolder(files)} />
        {imported ? <>
          {imported.source_url ? <Text variant="body">Copied from {imported.source_url}</Text> : null}
          <Text variant="body">{imported.page_count ?? imported.pages.length} pages · {imported.files_index?.file_count ?? Object.keys(imported.files).length} files · {imported.bytes.toLocaleString()} bytes</Text>
          {imported.skipped?.length ? <div role="note" className="text-sm text-[var(--text-muted)]"><p>Some pages or files stayed on the original site:</p>{imported.skipped.map(item => <p key={`${item.address}:${item.reason}`}>{item.address}: {item.reason}</p>)}</div> : null}
          {imported.problems.length ? <div role="alert" className="text-sm text-[var(--text-muted)]">{imported.problems.map(problem => <p key={problem}>{problem}</p>)}</div> : null}
          {imported.warnings.length ? <div role="note" className="text-sm text-[var(--text-muted)]">{imported.warnings.map(warning => <p key={warning}>{warning}</p>)}</div> : null}
          <Input label="App address name" value={importName} onChange={event => setImportName(event.currentTarget.value)} hint="Use lowercase letters, numbers, and hyphens." />
          {selectedInstallation?.status === 'active' && projectAssembly ? <Button size="sm" variant="secondary" disabled={busy || !imported.can_publish || !/^[a-z][a-z0-9-]{1,79}$/.test(importName)} onClick={() => addImportedSource()}>Add as a source to this site</Button> : null}
          <Button size="sm" variant="primary" disabled={busy || !imported.can_publish || !/^[a-z][a-z0-9-]{1,79}$/.test(importName)} onClick={() => createImported()}>Create public app</Button>
        </> : null}
      </Container>
      <Container layout="vertical" gap="sm" padding="md">
        {selectedInstallation?.can_manage_domains === false
          ? <Text variant="caption">Only the site owner can link its original project.</Text>
          : <PublicAppSourcePanel routeHint={editorPage?.route} installationId={selectedInstallation ? selected : undefined} sourceRoutes={sourceRoutes} />}
      </Container>
    </Container>
    {spaces.length ? <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
      <Text variant="heading-xs">Review on a board</Text>
      <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" padding="md" className="min-w-0">
        <Select value={screenId} onValueChange={value => { if (typeof value === 'string') setScreenId(value); }}>
          <SelectTrigger aria-label="Screen" size="sm" className="min-w-0 max-w-[14rem]"><SelectValue>{screens.find(row => row.id === screenId)?.label ?? 'Choose a screen'}</SelectValue></SelectTrigger>
          <SelectPopup>{screens.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
        </Select>
        {spaces.length > 1 ? <Select value={boardSpace} onValueChange={value => { if (typeof value === 'string') setBoardSpace(value); }}>
          <SelectTrigger aria-label="Board for this screen" size="sm" className="min-w-0 max-w-[12rem]"><SelectValue>{spaces.find(row => row.space_id === boardSpace)?.title ?? 'Choose a pursuit'}</SelectValue></SelectTrigger>
          <SelectPopup>{spaces.map(row => <SelectItem key={row.space_id} value={row.space_id}>{row.title}</SelectItem>)}</SelectPopup>
        </Select> : null}
        <Button size="sm" variant="secondary" disabled={!screenId || !boardSpace} pendingLabel="Putting on the board" doneLabel="On the board" errorLabel="Try again" onClick={putScreenOnBoard}>{spaces.length > 1 ? 'Put every size on board' : `Put every size on ${spaces[0].title}'s board`}</Button>
      </Container>
    </Container> : null}
    </Container> : null}
    {!installations.length ? <p className="text-sm text-[var(--text-muted)]">{fullListLoaded ? 'No public apps are installed here yet.' : 'Checking your sites…'}</p> : null}
    {message ? <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-primary)] p-3 text-sm">
      <p role="status" className="min-w-0 flex-1 break-words">{message}</p>
      {needsPlan ? <Button size="xs" variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.plan' } }))}>See plans</Button> : null}
    </div> : null}
    {pane === 'design' && projectAssembly && (projectAssembly.sources.length > 1 || !routeInCanvas) ? <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3" aria-label="App project">
      <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
        <div className="min-w-0 flex-1"><Text variant="heading-xs">{projectAssembly.name}</Text><Text variant="caption">{projectAssembly.sources.length} {projectAssembly.sources.length === 1 ? 'source' : 'sources'} · {projectRoutes.length} web {projectRoutes.length === 1 ? 'route' : 'routes'} in one saved project</Text></div>
        <Button size="sm" variant="secondary" onClick={() => setPane('settings')}>Manage sources</Button>
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="end" wrap="wrap" className="min-w-0">
        {projectAssembly.sources.length ? <Select value={activeProjectSource ?? ''} onValueChange={value => {
          if (typeof value !== 'string') return;
          setProjectSourceKey(value);
          const first = projectRoutes.find(page => page.source === value);
          if (first) chooseProjectRoute(first.id);
          else setProjectRouteId(null);
        }}>
          <SelectTrigger aria-label="Project source" className="min-w-0 flex-1"><SelectValue>{projectAssembly.sources.find(row => row.key === activeProjectSource)?.project.name ?? 'Choose a source'}</SelectValue></SelectTrigger>
          <SelectPopup>{projectAssembly.sources.map(row => <SelectItem key={row.key} value={row.key}>{row.project.name}</SelectItem>)}</SelectPopup>
        </Select> : null}
        {projectSourceRoutes.length ? <Select value={selectedSourceRoute?.id ?? ''} onValueChange={value => { if (typeof value === 'string') chooseProjectRoute(value); }}>
          <SelectTrigger aria-label="Project route" className="min-w-0 flex-1"><SelectValue>{selectedSourceRoute ? `${pageName(selectedSourceRoute.path)} · ${selectedSourceRoute.path}` : 'Choose a route'}</SelectValue></SelectTrigger>
          <SelectPopup>{projectSourceRoutes.map(page => <SelectItem key={page.id} value={page.id}>{`${pageName(page.path)} · ${page.path}`}</SelectItem>)}</SelectPopup>
        </Select> : <Text variant="caption">This source has no web route in the saved project.</Text>}
      </Container>
      {selectedSourceRoute ? <Text variant="caption">{selectedSourceRoute.source_path} · {routeInCanvas ? 'Editable on the canvas' : 'Saved in the project; unavailable in this canvas'}</Text> : null}
    </Container> : null}
    {pane === 'design' && (!source || !model) ? <Container layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-4" aria-label="Design status">
      <Text variant="heading-xs">{selectedInstallation ? siteLoadStatus === 'loading' ? 'Opening this site…' : siteLoadStatus === 'failed' ? 'This site could not load' : 'No page is available to edit' : 'Bring a site into Design'}</Text>
      <Text variant="body">{selectedInstallation ? siteLoadStatus === 'loading' ? 'Reading the saved pages and sources.' : siteLoadStatus === 'failed' ? 'The saved site or its page files did not load. Check the message above, then try loading this site again.' : 'This site has no page that can open in the visual canvas. Check its sources and routes.' : 'Copy a public site or add a built site folder to start a visual project.'}</Text>
      {selectedInstallation ? siteLoadStatus === 'failed' ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => reload(selected).catch(error => setMessage(errorWords(error)))}>Load site again</Button> : siteLoadStatus === 'ready' ? <Button size="sm" variant="secondary" onClick={() => setPane('settings')}>Manage sources</Button> : null : <Button size="sm" variant="secondary" onClick={() => setPane('settings')}>Add a site</Button>}
    </Container> : null}
    {source && model ? <>
      {pane === 'design' ? <div className="flex min-h-0 flex-col gap-3" inert={busy || undefined}>
        {draft ? <span className="text-xs text-[var(--text-muted)]">Draft saved {new Date((draft as Source & { saved_at?: string }).saved_at ?? Date.now()).toLocaleString()}</span> : null}
        {selectedCard?.presentation ? <PublicCardOptions key={`${selectedCard.id}:${selectedCard.capability.operation}:${selectedCatalogItem?.operations?.includes('run')}:${JSON.stringify(selectedCard.presentation)}`} initial={selectedCard.presentation} visitorView={selectedCardView}
          operation={selectedCard.capability.operation === 'run' ? 'run' : 'open'} canRun={selectedCatalogItem?.operations?.includes('run') === true}
          onApply={applyCardPresentation} onClose={() => setSelectedCardId(null)} /> : null}
        {routeInCanvas && editorPage?.visual_supported ? <VisualHtmlEditor key={`${selected}:${editorPage.id}`} ref={visual} onReady={setVisualReady} html={model.html} css={model.css.map(file => file.content).join('\n')} revision={working?.revision ?? source.revision}
          baseUrl={new URL(editorPage.route, previewAddress(draft) ?? source.public_url).href}
          renderCss={model.canvas_css}
          pages={pages.map(page => ({ id: page.id, label: pageName(page.route), htmlPath: page.html_path, route: page.route }))} selectedPage={selectedPage} onChoosePage={id => { setProjectRouteId(null); setProjectSourceKey(null); choosePage(id); }} onSelection={setSelection} peers={peers} onPointer={pointAt}
          selectionPanel={selection ? <><div className="trillion-visual-editor__selection-actions">
            <p>{pageName(selection.route ?? selection.page_path)} · {selection.text.slice(0, 90) || selection.tag}</p>
            {controlShown('ai.page-edit') ? <>
              <Textarea label="What should change?" value={editRequest} onChange={event => setEditRequest(event.currentTarget.value)} placeholder="Describe the change you want" />
              <Button size="sm" variant="secondary" disabled={busy || !editRequest.trim() || selectedInstallation?.status !== 'active'} onClick={() => askAiToEditSelection()}>Ask my AI to edit</Button>
              <p>Your AI gets this exact element and the saved page version.</p>
            </> : null}
          </div>{selectedInstallation?.can_manage_domains === false ? null
            : <PublicAppSourcePanel selection={selection} installationId={selectedInstallation ? selected : undefined} sourceRoutes={sourceRoutes} />}</> : null}
          libraryItems={[
            { id: 'browse-media', group: 'Media', label: 'Your media', detail: 'Find recordings and files by name, words, or what they show.', action: 'Browse media', onChoose: () => window.open('/media', '_blank', 'noopener,noreferrer') },
            ...imageAssets.map(asset => ({ id: `asset:${asset.path}`, group: 'App asset', label: asset.label || asset.path, detail: asset.path, action: 'Place image', onChoose: () => {
              if (!visual.current?.placeImageAsset(asset.url, asset.label)) throw new Error('The page is still opening. Try again.');
              setMessage(`Added ${asset.path} to this draft. Save the draft, then publish to make it live.`);
            } })),
            ...working.actions.map(action => ({ id: `action:${action.id}`, group: 'Visitor action', ...publicAppActionLibraryCopy(action), action: 'Connect selected form', onChoose: () => void connectAction(action) })),
            ...catalog.map(item => item.capabilityKind && item.version
              ? { ...item, canDrag: true, action: item.operations?.includes('run') ? 'Add and run' : 'Add to page', onChoose: () => void placePublishedCapability(item) }
              : { ...item, action: 'Open in Trillion', onChoose: () => window.open(item.href, '_blank', 'noopener,noreferrer') }),
          ]} references={references} referencesQuery={referencesQuery} referencesStatus={referencesStatus} onSearchReferences={setReferencesQuery} /> : <Container layout="vertical" gap="sm" padding="md" className="min-w-0 rounded-lg border border-[var(--border-primary)]">
            <Text variant="heading-xs">{!routeInCanvas ? 'This route cannot open on the canvas yet' : 'Edit this route’s original code'}</Text>
            <Text variant="body">{!routeInCanvas
              ? selectedSourceRoute ? `${selectedSourceRoute.path} belongs to ${selectedProjectSource?.project.name ?? 'this source'}, but its page is not in the current visual draft. The saved source remains in this project.` : 'This source does not provide a web page for the visual draft.'
              : `Trillion found the ${pageName(editorPage?.route ?? '/')} page. Connect its original project, then open the running preview to select and edit its source.`}</Text>
            {!routeInCanvas && selectedProjectSource?.project.source.origin?.kind === 'github-repository' && selectedInstallation?.can_manage_domains !== false
              ? <PublicAppSourcePanel routeHint={selectedSourceRoute?.path} installationId={selected} sourceRoutes={sourceRoutes} /> : null}
            <Button size="sm" variant="secondary" onClick={() => setPane('settings')}>Open source settings</Button>
          </Container>}
      </div> : null}
      {pane === 'activity' ? <div className="grid gap-4">
        {analyticsStatus === 'loading' ? <Text variant="body">Checking visitors…</Text> : null}
        {analyticsStatus === 'failed' ? <Container layout="horizontal" gap="sm" alignItems="center"><Text variant="body">Visitor activity could not load.</Text><Button size="sm" variant="secondary" onClick={() => setAnalyticsRetry(count => count + 1)}>Load visitors again</Button></Container> : null}
        {analyticsStatus === 'ready' ? <>
        <div className="grid grid-cols-3 gap-3">{[['Page views', analytics?.page_views ?? 0], ['Visitors', analytics?.unique_visitors ?? 0], ['Responses', analytics?.submissions ?? 0]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"><div className="text-xs text-[var(--text-muted)]">{label}</div><strong className="mt-2 block text-2xl">{value}</strong></div>)}</div>
        <div className="rounded-xl border border-[var(--border-primary)] p-4"><h2 className="font-medium">Recent days</h2>{analytics?.days.length ? analytics.days.map(day => <div key={day.date} className="grid grid-cols-4 gap-2 border-b border-[var(--border-primary)] py-2 text-sm"><span>{day.date}</span><span>{day.page_views} views</span><span>{day.unique_visitors} visitors</span><span>{day.submissions} responses</span></div>) : <p className="pt-3 text-sm text-[var(--text-muted)]">No visits yet in the last 30 days.</p>}</div>
        </> : null}
      </div> : null}
      {pane === 'history' ? <div className="rounded-xl border border-[var(--border-primary)] p-4"><h2 className="mb-3 font-medium">Versions</h2><VersionHistory
        rows={versionsStatus === 'ready' ? versions?.history?.map(row => ({ id: row.revision, number: row.number, at: row.created_at, by: row.by, words: row.words, current: row.live, address: versions.addresses?.[row.revision] })) ?? [] : []}
        picture={pictureOfVersion}
        onRestore={selectedInstallation?.status === 'active' ? restore : undefined}
        onRestoreAsDraft={selectedInstallation ? restoreAsDraft : undefined}
        emptyWords={versionsStatus === 'loading' ? 'Checking earlier versions…' : versionsStatus === 'failed' ? 'Earlier versions could not load.' : 'Your first published version will appear here after an edit.'}
      />{versionsStatus === 'failed' ? <Button size="sm" variant="secondary" onClick={() => setVersionsRetry(count => count + 1)}>Load versions again</Button> : null}</div> : null}
    </> : null}
  </Container>;
}

function PublicAppsRoot(props: Props) {
  const loaded = useScreenLoad('public-apps', {
    loading: { label: 'Loading your public apps', layout: 'rows' },
    read: readPublicApps,
    failed: refusal('Your public apps could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <PublicApps {...props} loaded={loaded.value} />;
}

export function mountPublicAppsScreen(element: HTMLElement, props: Props = {}): () => void {
  const root = createRoot(element);
  root.render(<ErrorBoundary zoneName="Sites"><PublicAppsRoot {...props} /></ErrorBoundary>);
  return () => { root.unmount(); element.replaceChildren(); };
}
