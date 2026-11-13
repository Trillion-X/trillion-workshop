// Original project editing stays separate from the imported HTML/CSS draft.
// A selection is editable here only after the connected repository resolves it.
import React, { useEffect, useState } from 'react';
import { Button, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea } from '../../parts/ui';
import { sourceProjectSelection, type VisualSelectionRef } from '../../parts/ui/show/public-app-editor/selection-ref';
import { FramesCanvas, type CanvasFrame } from '../../parts/ui/show/frames-canvas/FramesCanvas';
import BREAKPOINTS from '../../parts/ui/show/public-app-editor/breakpoints.json';
import { readJson } from './api';
import { putSizesOnBoard, type BoardSpace } from './put-sizes-on-board';
import { nativeProjectFromXcodeDescriptor } from '../native-xcode-project.mjs';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Project = { id: string; owner: string; repo: string; branch: string; commit: string; connected_at: string; generation?: string; revision: string; current_commit?: string; preview_url?: string | null; live_url?: string | null };
type Locator = { path: string; language: string; tag: string; commit: string; project_id: string; file_sha: string };
type ResolveResult = { status: string; reason?: string; locator?: Locator; preview_revision?: string };
type EditResult = { status: string; reason?: string; changed_path?: string; commit?: string; verification?: { source_readback: boolean; build: string; preview: string; live: string } };
type VerifyResult = { status: string; build: string; note?: string; preview?: { status: string; reason?: string }; live?: { status: string; reason?: string }; preview_url?: string | null; live_url?: string | null };
type PreviewResult = { status: string; reason?: string; image_base64?: string; current_commit?: string; width?: number; height?: number };
type SelectionResult = { status: string; reason?: string; selection?: VisualSelectionRef };
type SourceRoute = { project_id: string; path: string };
const ROOT = '/work/api/source-projects';

export function PublicAppSourcePanel({ selection, routeHint, installationId, sourceRoutes = [] }: {
  selection?: VisualSelectionRef; routeHint?: string; installationId?: string; sourceRoutes?: SourceRoute[];
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(null);
  const [linkLoaded, setLinkLoaded] = useState(!installationId);
  const [showConnect, setShowConnect] = useState(false);
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const [previewUrl, setPreviewUrl] = useState('');
  const [liveUrl, setLiveUrl] = useState('');
  const [xcodeProject, setXcodeProject] = useState('');
  const [iosScheme, setIosScheme] = useState('');
  const [macosScheme, setMacosScheme] = useState('');
  const [nativeProjectUrl, setNativeProjectUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resolved, setResolved] = useState<{ locator: Locator; sourceSelection: NonNullable<ReturnType<typeof sourceProjectSelection>>; commit: string } | null>(null);
  const [editKind, setEditKind] = useState<'text' | 'style'>('text');
  const [value, setValue] = useState(selection?.text ?? '');
  const [property, setProperty] = useState('color');
  const [written, setWritten] = useState<EditResult | null>(null);
  const [verification, setVerification] = useState<VerifyResult | null>(null);
  const [route, setRoute] = useState(routeHint ?? '/');
  // The running page at every size in breakpoints.json, side by side on one canvas; each frame fills in as it is drawn.
  const [previews, setPreviews] = useState<Record<string, PreviewResult | { status: 'drawing' }>>({});
  const [previewCommit, setPreviewCommit] = useState<string | null>(null);
  const [remoteSelection, setRemoteSelection] = useState<VisualSelectionRef | null>(null);
  const [spaces, setSpaces] = useState<BoardSpace[]>([]);
  const activeSelection = remoteSelection ?? selection;
  const availableRoutes = sourceRoutes.filter(row => row.project_id === projectId);
  const siteLink = installationId ? `${ROOT}/site-link?installation_id=${encodeURIComponent(installationId)}` : null;
  const sourceReady = !installationId || linkLoaded && linkedProjectId === projectId && Boolean(projectId);
  const selectedProject = projects.find(item => item.id === projectId);
  const runningPreviewUrl = selectedProject?.preview_url ?? selectedProject?.live_url;
  const styleProperties = (activeSelection?.attributes.style ?? '').split(';').map(part => part.split(':', 1)[0].trim()).filter(name => /^(?:--|-)?[A-Za-z][\w-]*$/.test(name));
  const canEditText = Boolean(activeSelection?.text.trim());
  const clearSourceContext = () => {
    setPreviews({}); setPreviewCommit(null); setRemoteSelection(null);
    setResolved(null); setWritten(null); setVerification(null);
  };

  useEffect(() => () => { if (nativeProjectUrl) URL.revokeObjectURL(nativeProjectUrl); }, [nativeProjectUrl]);

  useEffect(() => {
    let live = true;
    void readJson<{ projects: Project[] }>(ROOT).then(answer => {
      if (!live) return;
      setProjects(answer.projects);
      setProjectId(current => current || (!installationId && answer.projects.length === 1 ? answer.projects[0].id : ''));
    }).catch(error => { if (live) setMessage(errorWords(error, 'Original project connections are unavailable.')); });
    if (siteLink) void readJson<{ source_project_id: string | null }>(siteLink).then(answer => {
      if (!live) return;
      setLinkedProjectId(answer.source_project_id);
      setProjectId(answer.source_project_id ?? '');
      setLinkLoaded(true);
    }).catch(error => { if (live) setMessage(errorWords(error, 'The site source connection is unavailable.')); });
    void readJson<{ spaces: BoardSpace[] }>('/work/api/spaces').then(answer => { if (live) setSpaces(answer.spaces); }).catch(() => {});
    return () => { live = false; };
  }, [installationId]);
  // Every size of the running page onto a space's board as frames the team reviews and can draw again.
  const putOnBoard = async (space: BoardSpace) => {
    if (!sourceReady) throw new Error('Link this repository to the site before using its preview.');
    const project = projects.find(item => item.id === projectId);
    try {
      await putSizesOnBoard({ space, name: `${project?.repo ?? 'Site'} · ${route.trim() || '/'}`, onProgress: setMessage,
        drawAt: width => `${ROOT}/${projectId}/preview?route=${encodeURIComponent(route.trim() || '/')}&width=${width}` });
      setMessage(`Every size is on the ${space.title} board.`);
    } catch (error) {
      setMessage(errorWords(error, 'The sizes could not be put on the board.'));
      throw error;
    }
  };
  useEffect(() => {
    if (routeHint) setRoute(routeHint);
  }, [routeHint]);
  useEffect(() => {
    // A selection in the installed site supersedes an older pick in the original preview.
    setRemoteSelection(null);
  }, [selection]);
  useEffect(() => {
    setResolved(null); setWritten(null); setVerification(null);
    setValue(activeSelection?.text.trim() ? activeSelection.text : activeSelection?.styles[styleProperties[0]] ?? '');
    setEditKind(activeSelection?.text.trim() ? 'text' : 'style'); setProperty(styleProperties[0] ?? 'color'); setMessage('');
  }, [activeSelection]);

  const run = async (job: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await job(); } catch (error) { setMessage(errorWords(error, 'The original project could not be changed.')); throw error; }
    finally { setBusy(false); }
  };
  const connect = () => run(async () => {
    const match = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/.exec(repository.trim());
    if (!match) throw new Error('Enter the GitHub repository as owner/repository.');
    const created = await readJson<Project>(ROOT, { method: 'POST', body: JSON.stringify({ owner: match[1], repo: match[2], branch: branch.trim(),
      ...(previewUrl.trim() ? { preview_url: previewUrl.trim() } : {}), ...(liveUrl.trim() ? { live_url: liveUrl.trim() } : {}),
    }) });
    setProjects(current => [...current.filter(item => item.id !== created.id), created]);
    setProjectId(created.id); setShowConnect(false); clearSourceContext();
    if (siteLink && !linkedProjectId) {
      const linked = await readJson<{ source_project_id: string }>(siteLink, { method: 'PUT', body: JSON.stringify({
        source_project_id: created.id, expected_source_project_id: linkedProjectId,
      }) });
      setLinkedProjectId(linked.source_project_id);
    }
    setMessage(`Connected ${created.owner}/${created.repo}${siteLink && (!linkedProjectId || linkedProjectId === created.id) ? ' to this site' : ''}.${(created.preview_url ?? created.live_url)
      ? ' Open its running web preview to select a page element.'
      : ' No running web address is linked. You can still prepare a separate native Xcode app project.'}`);
  });
  const linkSelected = () => run(async () => {
    if (!siteLink || !projectId || !linkLoaded) return;
    const linked = await readJson<{ source_project_id: string }>(siteLink, { method: 'PUT', body: JSON.stringify({
      source_project_id: projectId, expected_source_project_id: linkedProjectId,
    }) });
    setLinkedProjectId(linked.source_project_id);
    clearSourceContext();
    setMessage('This repository is linked to this site. Open its running preview to choose an original element.');
  });
  const unlinkSelected = () => run(async () => {
    if (!siteLink || !linkedProjectId || !linkLoaded) return;
    await readJson(siteLink, { method: 'DELETE', body: JSON.stringify({ expected_source_project_id: linkedProjectId }) });
    setLinkedProjectId(null); setProjectId(''); clearSourceContext();
    setMessage('The repository is no longer linked to this site.');
  });
  const removeSelected = () => run(async () => {
    const project = projects.find(item => item.id === projectId);
    if (!project) return;
    const latest = await readJson<{ projects: Project[] }>(ROOT);
    const current = latest.projects.find(item => item.id === project.id);
    if (!current || (current.generation ?? current.connected_at) !== (project.generation ?? project.connected_at)) {
      throw new Error('This connection was replaced. Reload the project list before removing it.');
    }
    if (current.revision !== project.revision) {
      setProjects(latest.projects);
      throw new Error('This connection changed. Review it before removing it.');
    }
    await readJson(`${ROOT}/${project.id}`, { method: 'DELETE', body: JSON.stringify({ expected_revision: project.revision }) });
    setProjects(current => current.filter(item => item.id !== project.id));
    setProjectId(''); clearSourceContext();
    setMessage(`Removed the saved connection to ${project.owner}/${project.repo}. GitHub and existing site files were kept.`);
  });
  const openPreview = () => run(async () => {
    if (!projectId) throw new Error('Choose an original project first.');
    if (!sourceReady) throw new Error('Link this repository to the site before editing its source.');
    const requestedRoute = route.trim();
    if (!/^\/(?!\/)[^?#\\]*$/.test(requestedRoute)) throw new Error('Enter a route within this project, such as / or /about/.');
    setRemoteSelection(null); setResolved(null); setWritten(null); setVerification(null); setPreviewCommit(null);
    setPreviews(Object.fromEntries(BREAKPOINTS.frames.map(frame => [frame.id, { status: 'drawing' as const }])));
    let opened = 0;
    let commit: string | null = null;
    let reason = '';
    // One size at a time, so the rendering service is never asked for every size at once.
    for (const frame of BREAKPOINTS.frames) {
      const shown = await readJson<PreviewResult>(`${ROOT}/${projectId}/preview?route=${encodeURIComponent(requestedRoute)}&width=${frame.width}`);
      setPreviews(current => ({ ...current, [frame.id]: shown }));
      if (shown.status === 'ready' && shown.image_base64 && shown.current_commit) { opened += 1; commit = shown.current_commit; } else reason = shown.reason ?? reason;
    }
    if (!opened || !commit) throw new Error(reason || 'The running preview could not be opened.');
    setPreviewCommit(commit);
    setMessage('Click an element on any size to locate its original source. The preview does not attest its deployed commit.');
  });
  const selectFromPreview = (frameId: string, point: { x: number; y: number }) => run(async () => {
    if (!sourceReady) throw new Error('Link this repository to the site before editing its source.');
    const frame = BREAKPOINTS.frames.find(row => row.id === frameId);
    if (!projectId || !previewCommit || !frame) return;
    const chosen = await readJson<SelectionResult>(`${ROOT}/${projectId}/select`, { method: 'POST', body: JSON.stringify({
      route: route.trim(), expected_commit: previewCommit, x: point.x, y: point.y, width: frame.width,
    }) });
    if (chosen.status !== 'selected' || !chosen.selection) throw new Error(chosen.reason ?? 'Select a visible page element.');
    setRemoteSelection(chosen.selection);
    setMessage(`Selected ${chosen.selection.tag} on ${frame.label}: ${chosen.selection.text.slice(0, 100) || chosen.selection.attributes['aria-label'] || 'element'}. Find its original element next.`);
  });
  const canvasFrames: CanvasFrame[] = BREAKPOINTS.frames.map(frame => {
    const shown = previews[frame.id];
    const ready = shown && 'image_base64' in shown && shown.image_base64 ? shown : null;
    return { id: frame.id, label: `${frame.label} · ${frame.width}`, width: frame.width, height: ready?.height ?? frame.height,
      ...(ready ? { image: `data:image/png;base64,${ready.image_base64}` } : { state: shown?.status === 'drawing' ? 'Drawing this size…' : shown && 'reason' in shown && shown.reason ? shown.reason : '' }) };
  });
  const resolve = () => run(async () => {
    if (!sourceReady) throw new Error('Link this repository to the site before editing its source.');
    if (!activeSelection) throw new Error('Select an element in the running preview first.');
    const project = projects.find(item => item.id === projectId);
    if (!project) throw new Error('Choose the original project first.');
    const latest = await readJson<Project>(`${ROOT}/${project.id}`);
    const commit = latest.current_commit ?? latest.commit;
    if (activeSelection.source_revision && activeSelection.source_revision !== commit) throw new Error('The page preview and original project are at different revisions. Open the current project preview and select the element again.');
    const picked = sourceProjectSelection(activeSelection, project.id, commit);
    if (!picked) throw new Error('This element needs visible text and a stable attribute to find its original source.');
    const result = await readJson<ResolveResult>(`${ROOT}/${project.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ expected_commit: commit, selection: picked }),
    });
    if (result.status !== 'resolved' || !result.locator) throw new Error(result.reason ?? 'This element could not be linked to one source file.');
    setResolved({ locator: result.locator, sourceSelection: picked, commit });
    setWritten(null); setVerification(null);
    setMessage(`Found ${result.locator.path} in the original project and matched the element on its running preview.${result.preview_revision === 'unverified' ? ' The preview deployment version is unverified.' : ''}`);
  });
  const edit = () => run(async () => {
    if (!sourceReady) throw new Error('Link this repository to the site before editing its source.');
    if (!resolved || !projectId) return;
    const intent = editKind === 'text' ? { kind: 'text', value } : { kind: 'style', property: property.trim(), value };
    const result = await readJson<EditResult>(`${ROOT}/${projectId}/edit`, { method: 'POST', body: JSON.stringify({
      expected_commit: resolved.commit, selection: resolved.sourceSelection, locator: resolved.locator, intent,
    }) });
    if (!['source_written', 'source_written_verification_pending'].includes(result.status) || !result.commit) throw new Error(result.reason ?? 'This property cannot be changed in the original source.');
    setWritten(result); setResolved(null);
    try {
      const checked = await readJson<VerifyResult>(`${ROOT}/${projectId}/verify`, { method: 'POST', body: JSON.stringify({ commit: result.commit }) });
      setVerification(checked);
      setMessage(`Changed ${result.changed_path} in the original project. ${checked.status === 'rendered_value_observed' ? 'The changed value appears on the preview and live page; the deployed version and backend behavior are still unverified.' : checked.build === 'failed' ? 'The connected build failed.' : checked.build === 'passed' ? `The build passed. Preview: ${checked.preview?.status ?? 'unverified'}; live page: ${checked.live?.status ?? 'unverified'}.` : 'The connected build is not yet verified.'}`);
    } catch (error) {
      setMessage(`Changed ${result.changed_path} in the original project. Build and page checks are unavailable: ${errorWords(error, 'try again shortly')}.`);
    }
  });
  const verifyWritten = () => run(async () => {
    if (!written?.commit || !projectId) return;
    const checked = await readJson<VerifyResult>(`${ROOT}/${projectId}/verify`, { method: 'POST', body: JSON.stringify({ commit: written.commit }) });
    setVerification(checked);
    setMessage(checked.status === 'rendered_value_observed'
      ? 'The changed value appears on the preview and live page. The deployed version and backend behavior are still unverified.'
      : `Build: ${checked.build}. Preview: ${checked.preview?.status ?? 'unverified'}. Live page: ${checked.live?.status ?? 'unverified'}.`);
  });
  const prepareNativeProject = async () => {
    setBusy(true); setMessage(''); setNativeProjectUrl(null);
    try {
      if (!projectId) throw new Error('Choose a connected GitHub repository first.');
      const connected = await readJson<Project>(`${ROOT}/${projectId}`);
      const commit = connected.current_commit ?? connected.commit;
      const schemes = { ...(iosScheme.trim() ? { ios: iosScheme.trim() } : {}),
        ...(macosScheme.trim() ? { macos: macosScheme.trim() } : {}) };
      const targets = Object.keys(schemes) as Array<'ios' | 'macos'>;
      const project = nativeProjectFromXcodeDescriptor({ repository: `github:${connected.owner}/${connected.repo}`,
        commit, xcode_project: xcodeProject.trim(), schemes }, {
        id: `native-${connected.id}`, name: connected.repo.slice(0, 80), targets,
        connectedOrigin: { kind: 'github-repository', project_id: connected.id, owner: connected.owner,
          repo: connected.repo, branch: connected.branch, commit },
      });
      const bytes = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: 'application/json' });
      setNativeProjectUrl(URL.createObjectURL(bytes));
      setMessage(`Prepared a native app project for ${connected.owner}/${connected.repo} at ${commit.slice(0, 12)}. The local Xcode builder will verify this project path and the chosen schemes against that commit before building.`);
    } catch (error) {
      setMessage(errorWords(error, 'The native app project could not be prepared.'));
    } finally {
      setBusy(false);
    }
  };

  return <div className="trillion-visual-editor__selection-actions">
    <h3>Original project</h3>
    <p>Open a connected running site, select what you see, and change its original GitHub source.</p>
    {projects.length ? <Select value={projectId} onValueChange={value => { if (typeof value === 'string') { setProjectId(value); clearSourceContext(); } }}>
      <SelectTrigger aria-label="Original project" className="min-w-0"><SelectValue>{(() => { const project = projects.find(item => item.id === projectId); return project ? `${project.repo} · ${project.branch}` : 'Choose a project'; })()}</SelectValue></SelectTrigger>
      <SelectPopup>{projects.map(project => <SelectItem key={project.id} value={project.id}>{`${project.owner}/${project.repo} · ${project.branch}`}</SelectItem>)}</SelectPopup>
    </Select> : null}
    {availableRoutes.length ? <Select value={availableRoutes.some(row => row.path === route) ? route : '__custom_route__'}
      onValueChange={value => { if (typeof value === 'string' && value !== '__custom_route__') { setRoute(value); clearSourceContext(); } }}>
      <SelectTrigger aria-label="Route in connected app" className="min-w-0"><SelectValue>{availableRoutes.find(row => row.path === route)?.path ?? 'Other route'}</SelectValue></SelectTrigger>
      <SelectPopup>{availableRoutes.map(row => <SelectItem key={row.path} value={row.path}>{row.path}</SelectItem>)}<SelectItem value="__custom_route__">Other route</SelectItem></SelectPopup>
    </Select> : null}
    {siteLink && linkLoaded ? <>
      <Text variant="caption">A repository link lets this site edit that original source. It does not copy its backend or sign-in.</Text>
      {projectId && projectId !== linkedProjectId ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => linkSelected()}>Use this repository for this site</Button> : null}
      {linkedProjectId && projectId === linkedProjectId ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => unlinkSelected()}>Disconnect repository from this site</Button> : null}
    </> : null}
    {selectedProject ? <Button size="sm" variant="danger" disabled={busy || !linkLoaded || linkedProjectId === selectedProject.id} onClick={() => removeSelected()}
      pendingLabel="Removing connection" doneLabel="Connection removed" errorLabel="Try again">
      Remove saved connection
    </Button> : null}
    {selectedProject && linkedProjectId === selectedProject.id ? <Text variant="caption">Disconnect this repository from the site before removing its saved connection.</Text> : null}
    <Button size="sm" variant="secondary" onClick={() => setShowConnect(current => !current)}>{showConnect ? 'Hide connection' : 'Connect original project'}</Button>
    {showConnect ? <div className="trillion-visual-editor__selection-actions">
      <Input label="GitHub repository" placeholder="owner/repository" value={repository} onChange={event => setRepository(event.currentTarget.value)} />
      <Input label="Branch" value={branch} onChange={event => setBranch(event.currentTarget.value)} />
      <Input label="Web preview address (optional)" placeholder="https://preview.example.com" value={previewUrl} onChange={event => setPreviewUrl(event.currentTarget.value)} />
      <Input label="Live address" placeholder="https://example.com" value={liveUrl} onChange={event => setLiveUrl(event.currentTarget.value)} />
      <p>A running web address lets you select and edit browser pages. A native Xcode project can be prepared separately from this repository's committed Swift source.</p>
      <Button size="sm" variant="secondary" disabled={busy || !repository.trim() || !branch.trim() || !linkLoaded} onClick={() => connect()}>Connect repository</Button>
    </div> : null}
    {projectId ? <div className="trillion-visual-editor__selection-actions">
      <h4>Native iPhone or Mac app</h4>
      <p>This creates a project file for the connected repository's original Xcode app. Its Swift screens stay native; this does not wrap the website or publish a signed app.</p>
      <Input label="Xcode project path" placeholder="Example.xcodeproj" value={xcodeProject} onChange={event => setXcodeProject(event.currentTarget.value)} />
      <Input label="iPhone app scheme, if needed" value={iosScheme} onChange={event => setIosScheme(event.currentTarget.value)} />
      <Input label="Mac app scheme, if needed" value={macosScheme} onChange={event => setMacosScheme(event.currentTarget.value)} />
      <Button size="sm" variant="secondary" disabled={busy || !xcodeProject.trim() || (!iosScheme.trim() && !macosScheme.trim())} onClick={() => prepareNativeProject()}>Prepare native app project</Button>
      {nativeProjectUrl ? <a href={nativeProjectUrl} download="native-app-project.json">Download native app project</a> : null}
      <Text variant="caption">Enter the schemes you need. The downloaded file pins the current Git commit. The local Xcode builder checks the project and those schemes against a checkout at that commit; source files and compiled apps are not included.</Text>
    </div> : null}
    {projectId ? <div className="trillion-visual-editor__selection-actions">
      <Input label="Page route" value={route} onChange={event => setRoute(event.currentTarget.value)} placeholder="/" />
      {!runningPreviewUrl ? <Text variant="caption">Link a running web address to edit browser pages here. The native Xcode project above is a separate output.</Text> : null}
      <Button size="sm" variant="secondary" disabled={busy || !sourceReady || !runningPreviewUrl} onClick={() => openPreview()}>Open running preview</Button>
      {sourceReady && previewCommit && spaces.length ? spaces.slice(0, 3).map(space => <Button key={space.space_id} size="sm" variant="secondary" disabled={busy} pendingLabel="Putting on the board" doneLabel="On the board" errorLabel="Try again" onClick={() => putOnBoard(space)}>{`Put sizes on ${space.title}'s board`}</Button>) : null}
      {Object.keys(previews).length ? <div className="trillion-source-frames"><FramesCanvas label="The running site at every size" frames={canvasFrames} gap={BREAKPOINTS.gap} onPick={(frameId, point) => void selectFromPreview(frameId, point)} /></div> : null}
      {remoteSelection ? <p>Selected {remoteSelection.tag}: {remoteSelection.text.slice(0, 120) || remoteSelection.attributes['aria-label'] || 'element'}</p> : null}
    </div> : null}
    {projectId && activeSelection ? <Button size="sm" variant="secondary" disabled={busy || !sourceReady} onClick={() => resolve()}>Find original element</Button> : null}
    {projectId && activeSelection && !activeSelection.source_revision ? <p>This preview does not attest its deployed source version. Trillion requires a unique match in the current project before editing.</p> : null}
    {resolved ? <div className="trillion-visual-editor__selection-actions">
      <p>Source file: {resolved.locator.path}</p>
      <div className="trillion-visual-editor__devices">
        {canEditText ? <Button size="sm" variant={editKind === 'text' ? 'accent' : 'secondary'} onClick={() => { setEditKind('text'); setValue(activeSelection?.text ?? ''); }}>Text</Button> : null}
        {styleProperties.length ? <Button size="sm" variant={editKind === 'style' ? 'accent' : 'secondary'} onClick={() => { setEditKind('style'); setProperty(styleProperties[0]); setValue(activeSelection?.styles[styleProperties[0]] ?? ''); }}>Inline style</Button> : null}
      </div>
      {editKind === 'style' ? <div className="trillion-visual-editor__devices">{styleProperties.map(name => <Button key={name} size="sm" variant={property === name ? 'accent' : 'secondary'} onClick={() => { setProperty(name); setValue(activeSelection?.styles[name] ?? ''); }}>{name}</Button>)}</div> : null}
      {canEditText || styleProperties.length ? <>
        <Textarea label={editKind === 'text' ? 'Original text' : `New ${property} value`} value={value} onChange={event => setValue(event.currentTarget.value)} />
        <Button size="sm" variant="primary" disabled={busy || !sourceReady || !value.trim()} onClick={() => edit()}>Change original source</Button>
      </> : <p>This element has no directly editable text or inline style.</p>}
    </div> : null}
    {written ? <><p>Saved in the original project at version {written.commit?.slice(0, 12)}. {verification?.note ?? 'The build and live page still need checking.'}</p>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => verifyWritten()}>Check build and pages again</Button></> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
