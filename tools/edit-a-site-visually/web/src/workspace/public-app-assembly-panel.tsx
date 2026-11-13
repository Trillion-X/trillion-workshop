// NO PRIOR: searched the shared UI package and 21st.dev's project/source management results. Reuse the shared Switch, Button, and Container.
import React, { useEffect, useMemo, useState } from 'react';
import { Button, Container, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text, downloadTextFile } from '../../parts/ui';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { checkedProjectForTarget, changeSourceTargets, removeCheckedSource } from './public-app-assembly-model.mjs';
import { readJson } from './api';
import { openFile } from './open-screen';

type Target = 'web' | 'ios' | 'macos';
type NativeOutputKind = 'preview' | 'xcode-project';
type Project = { id: string; name: string; source: { kind: string }; outputs: { target: Target; status: string; reason?: string }[] };
type SourceRow = { key: string; targets: Target[]; project: Project };
type SavedProject = { schema: string; id: string; name: string; revision: string; sources: SourceRow[]; pages: unknown[]; assets: unknown[]; behaviors: unknown[]; capabilities: unknown[]; outputs: unknown[] };
type Assembly = SavedProject & { source_files: Record<string, Record<string, { blob_ref: string; media_type: string; size: number }>>; source_files_revision: string };
type ConnectedRepository = { id: string; owner: string; repo: string; branch: string; commit: string; stale?: boolean };
const targetNames: Record<Target, string> = { web: 'Web', ios: 'iPhone', macos: 'Mac' };

function downloadProject(name: string, target: Target, project: unknown) {
  downloadTextFile(JSON.stringify(project, null, 2), `${name}-${target}-project.json`, 'application/json');
}

export function PublicAppAssemblyPanel({ assembly, installationId, liveUrl, busy, onSave, onAddRepository, onBuildNative }: {
  assembly: Assembly;
  installationId: string;
  liveUrl?: string;
  busy: boolean;
  onSave(project: SavedProject): Promise<void>;
  onAddRepository(projectId: string): Promise<'hosted' | 'files'>;
  onBuildNative(target: 'ios' | 'macos', expectedRevision: string, outputKind: NativeOutputKind): Promise<{ identity: string; name: string; target: 'ios' | 'macos'; signing: 'unsigned' | 'not-signed'; distribution: string; said: string }>;
}) {
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [repositories, setRepositories] = useState<ConnectedRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [addingRepository, setAddingRepository] = useState(false);
  const [buildingOutput, setBuildingOutput] = useState<string | null>(null);
  const [builtApp, setBuiltApp] = useState<{ identity: string; name: string; target: 'ios' | 'macos' } | null>(null);
  const [builder, setBuilder] = useState<{ installationId: string; available: boolean } | null>(null);
  const builderAvailable = builder?.installationId === installationId && builder.available;
  useEffect(() => {
    let current = true;
    void readJson<{ projects: ConnectedRepository[] }>('/work/api/source-projects').then(result => {
      if (!current) return;
      setRepositories(result.projects);
      setRepositoryId(id => id || result.projects[0]?.id || '');
    }).catch(() => { if (current) setRepositories([]); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    void readJson<{ available: boolean }>(`/work/api/public-app/installations/${installationId}/native-build`).then(result => {
      if (current) setBuilder({ installationId, available: result.available === true });
    }).catch(() => { if (current) setBuilder({ installationId, available: false }); });
    return () => { current = false; };
  }, [installationId]);
  const available = useMemo(() => {
    const result = new Map<Target, { ready: boolean; previewable: boolean; detail: string }>();
    for (const target of Object.keys(targetNames) as Target[]) {
      try {
        const project = checkedProjectForTarget(assembly, target);
        const output = project.outputs.find(row => row.target === target);
        const previewable = target !== 'web' && project.source.kind === 'public-app-installation' &&
          output?.status === 'buildable' && output.presenter === 'webview' &&
          !project.capabilities.some(row => row.access === 'signed-in');
        const detail = target === 'web'
          ? 'A checked web project description is available.'
          : project.source.native?.kind === 'xcode-project'
            ? 'The connected Xcode project is saved. Building and signing its app are unavailable here.'
            : previewable
              ? `This site can provide an Xcode project and an unsigned ${target === 'ios' ? 'iPhone Simulator' : 'Mac'} preview.${builderAvailable ? '' : ' Native building is unavailable right now.'}`
              : 'A project description is available. A native app build is unavailable for this source.';
        result.set(target, { ready: true, previewable, detail });
      } catch (error) {
        result.set(target, { ready: false, previewable: false, detail: target === 'web' && liveUrl
          ? 'The installed site is live. Additional sources have not been published with it.'
          : errorWords(error, `A ${targetNames[target]} project is not ready.`) });
      }
    }
    return result;
  }, [assembly, liveUrl, builderAvailable]);

  const save = async (next: SavedProject) => {
    if (busy || saving) return;
    setSaving(true);
    setMessage('');
    try {
      await onSave(next);
      setMessage('Source choices saved.');
    } catch (error) {
      setMessage(errorWords(error, 'Source choices could not be saved.'));
    } finally { setSaving(false); }
  };

  const buildNative = async (target: 'ios' | 'macos', outputKind: NativeOutputKind) => {
    if (busy || saving || buildingOutput) return;
    setBuildingOutput(`${target}:${outputKind}`);
    setBuiltApp(null);
    setMessage('');
    try {
      const result = await onBuildNative(target, assembly.revision, outputKind);
      setBuiltApp({ identity: result.identity, name: result.name, target: result.target });
      setMessage(result.said);
    } catch (error) {
      setMessage(errorWords(error, outputKind === 'xcode-project' ? 'The Xcode project could not be exported.' : 'The app could not be built.'));
    } finally { setBuildingOutput(null); }
  };

  return <Container layout="vertical" gap="md" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
    <Container layout="vertical" gap="xs" className="min-w-0">
      <Text variant="heading-xs">App sources</Text>
      <Text variant="body">Choose which checked source provides each app target. The installed site stays connected as the web source.</Text>
    </Container>
    <Container layout="vertical" gap="sm" className="min-w-0">
      {assembly.sources.map(source => {
        const isInstalledSite = source.key === 'site';
        const targets = source.project.outputs.filter(row => row.status !== 'unsupported').map(row => row.target);
        return <Container key={source.key} layout="vertical" gap="sm" className="min-w-0 rounded-lg border border-[var(--border-primary)] p-3">
          <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
            <div className="min-w-0 flex-1">
              <Text variant="body">{source.project.name}</Text>
              <Text variant="caption">{source.project.source.kind === 'repository-source' ? 'Connected repository' : source.project.source.kind === 'public-url-copy' ? 'Copied public site' : source.project.source.kind === 'site-folder' ? 'Site folder' : 'App source'}</Text>
            </div>
            {!isInstalledSite ? <Button size="sm" variant="secondary" disabled={busy || saving || assembly.sources.length < 2} onClick={() => void save(removeCheckedSource(assembly, source.key))}>Remove source</Button> : null}
          </Container>
          <Container layout="horizontal" gap="sm" wrap="wrap" className="min-w-0">
            {(Object.keys(targetNames) as Target[]).map(target => {
              const supported = targets.includes(target);
              const checked = source.targets.includes(target);
              return <Container key={target} layout="horizontal" gap="xs" alignItems="center" className="min-w-0">
                <Switch label={`${targetNames[target]} target for ${source.project.name}`} checked={checked}
                  disabled={busy || saving || !supported || (isInstalledSite && target === 'web') || (checked && source.targets.length === 1)}
                  onCheckedChange={enabled => {
                    try {
                      const nextTargets = enabled ? [...source.targets, target] : source.targets.filter(item => item !== target);
                      void save(changeSourceTargets(assembly, source.key, nextTargets));
                    } catch (error) { setMessage(errorWords(error, 'This target choice is unavailable.')); }
                  }} />
                <Text variant="caption">{targetNames[target]}{supported ? '' : ' · unavailable'}</Text>
              </Container>;
            })}
          </Container>
        </Container>;
      })}
    </Container>
    {repositories.length ? <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
      <Select value={repositoryId} onValueChange={value => { if (typeof value === 'string') setRepositoryId(value); }}>
        <SelectTrigger aria-label="Connected GitHub repository" className="min-w-0 flex-1"><SelectValue>
          {(() => { const row = repositories.find(item => item.id === repositoryId); return row ? `${row.owner}/${row.repo} · ${row.branch}` : 'Choose a repository'; })()}
        </SelectValue></SelectTrigger>
        <SelectPopup>{repositories.map(row => <SelectItem key={row.id} value={row.id}>{`${row.owner}/${row.repo} · ${row.branch}`}</SelectItem>)}</SelectPopup>
      </Select>
      <Button size="sm" variant="secondary" disabled={busy || saving || addingRepository || !repositoryId}
        onClick={() => {
          if (addingRepository || !repositoryId) return;
          setAddingRepository(true); setMessage('');
          void onAddRepository(repositoryId).then(result => setMessage(result === 'hosted'
            ? 'The live app is now a linked page in this project. Its server, sign-in and native app still run at its original address.'
            : 'The GitHub source was saved with its exact commit. The live site has not changed.'))
            .catch(error => setMessage(errorWords(error, 'The GitHub source could not be added.')))
            .finally(() => setAddingRepository(false));
        }}>{addingRepository ? 'Reading repository…' : 'Add GitHub site'}</Button>
      <Text variant="caption">Static web files are added as editable pages. A running app without a root HTML page can be added as a link; its server, sign-in and native app stay at the original address.</Text>
    </Container> : <Text variant="caption">Connect a GitHub repository in Original project to add its pinned web files here.</Text>}
    <Container layout="vertical" gap="sm" className="min-w-0 border-t border-[var(--border-primary)] pt-3">
      <Text variant="heading-xs">App actions</Text>
      {(Object.keys(targetNames) as Target[]).map(target => {
        const state = available.get(target)!;
        return <Container key={target} layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
          <div className="min-w-0 flex-1">
            <Text variant="body">{targetNames[target]}</Text>
            <Text variant="caption">{state.detail}{state.ready ? ' This description does not change the live site or build an app.' : ''}</Text>
          </div>
          {target === 'web' && liveUrl ? <Button size="sm" variant="secondary" onClick={() => window.open(liveUrl, '_blank', 'noopener,noreferrer')}>Open live site</Button> : null}
          {state.ready ? <Button size="sm" variant="secondary" disabled={busy || saving} onClick={() => {
              try {
                if (target === 'web') downloadProject(assembly.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), target, checkedProjectForTarget(assembly, target));
                else void readJson<{ project: unknown }>(`/work/api/public-app/installations/${installationId}/native-build?target=${target}&expected_revision=${encodeURIComponent(assembly.revision)}`)
                  .then(result => downloadProject(assembly.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), target, result.project))
                  .catch(error => setMessage(errorWords(error, 'The project file could not be prepared.')));
              }
              catch (error) { setMessage(errorWords(error, 'The project file could not be prepared.')); }
            }}>Download project description</Button> : null}
          {target !== 'web' && state.previewable ? <Button size="sm" variant="secondary" disabled={!builderAvailable || busy || saving || buildingOutput !== null} onClick={() => buildNative(target, 'xcode-project')}>
            {buildingOutput === `${target}:xcode-project` ? 'Exporting Xcode project…' : 'Export Xcode project'}
          </Button> : null}
        </Container>;
      })}
    </Container>
    {available.get('ios')?.previewable || available.get('macos')?.previewable ? <Container layout="vertical" gap="sm" className="min-w-0 border-t border-[var(--border-primary)] pt-3">
      <Text variant="heading-xs">Build the installed site</Text>
      <Text variant="body">These are unsigned previews that show the published website inside an iPhone or Mac app window. The iPhone preview runs only in Simulator; the Mac preview stays on this Mac. Exporting and signing the wrapper does not move the site's screens or backend into native app code. Sites can save a connected app's original Xcode source, but cannot build or sign that native app yet.</Text>
      <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" className="min-w-0">
        {available.get('ios')?.previewable ? <Button size="sm" variant="secondary" disabled={!builderAvailable || busy || saving || buildingOutput !== null} onClick={() => buildNative('ios', 'preview')}>
          {buildingOutput === 'ios:preview' ? 'Building iPhone Simulator app…' : 'Build iPhone Simulator app'}
        </Button> : null}
        {available.get('macos')?.previewable ? <Button size="sm" variant="secondary" disabled={!builderAvailable || busy || saving || buildingOutput !== null} onClick={() => buildNative('macos', 'preview')}>
          {buildingOutput === 'macos:preview' ? 'Building Mac app…' : 'Build Mac app'}
        </Button> : null}
        {builtApp ? <Button size="sm" variant="secondary" onClick={() => openFile({ id: builtApp.identity, name: builtApp.name, type: 'application/zip' })}>Open in Files</Button> : null}
      </Container>
    </Container> : null}
    {message ? <Text variant="caption" role="status">{message}</Text> : null}
  </Container>;
}
