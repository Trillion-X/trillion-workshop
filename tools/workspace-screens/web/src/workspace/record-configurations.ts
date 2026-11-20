// Transport for the shared configuration controller. The account boundary and
// original sharing owner authorize every read/write for the UI and AI alike.
import {readJson} from './api';
import {notify} from '../../../../ui/show/coss/notifications';
import type {ConfigurationRecord, ConfigurationSource} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/configuration-controller.mjs';

const ROOT = '/work/api/configurations';
const post = <T,>(path: string, body: unknown) => readJson<T>(path, {method: 'POST', body: JSON.stringify(body)});
const query = (values: Record<string, unknown>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
type ShareRead = {configuration: ConfigurationRecord; can?: string[]};
const shared = (code: string, answer: ShareRead): ShareRead => ({...answer, configuration: {...answer.configuration,
  share_code: code, readOnly: !(answer.can ?? []).includes('edit')}});

// Whether this page keeps saved configurations on the Workshop (its /work/api/configurations). A host without them (the members
// page) answers from here: no saved views, nothing asked and nothing saved; a saved view that was opened by its address says so.
let savedViewsOffered = true;
export function setSavedViewsOffered(offered: boolean): void { savedViewsOffered = offered; }
const NOT_KEPT = 'Saved views are not kept on this page.';
const notKept = async (): Promise<never> => { throw new Error(NOT_KEPT); };

export function recordConfigurationSource({accessCode}: {accessCode?: string} = {}): ConfigurationSource {
  if (!savedViewsOffered) return {
    context: {resolveTimeBound: async () => null},
    list: async () => ({configurations: [], next_before: null}),
    listShared: async () => ({configurations: [], next_before: null}),
    read: notKept, readOffer: notKept, readShared: notKept, save: notKept, editShared: notKept, remove: notKept,
    share: notKept, copyLink: notKept,
  } as unknown as ConfigurationSource;
  const sharePath = (code: string) => `${ROOT}/shared/${encodeURIComponent(code)}${accessCode ? `?access_code=${encodeURIComponent(accessCode)}` : ''}`;
  return {
    context: {resolveTimeBound: async (point, now) => (await post<{value: number | null}>(`${ROOT}/context/time-bound`, {point, now})).value},
    list: input => readJson(`${ROOT}?${query(input)}`),
    listShared: input => readJson(`${ROOT}?${query({...input, visibility: 'shared'})}`),
    read: id => readJson(`${ROOT}/${encodeURIComponent(id)}`),
    readOffer: id => readJson(`${ROOT}/offers/${encodeURIComponent(id)}`),
    readShared: async code => shared(code, await readJson<ShareRead>(sharePath(code))),
    save: input => post(input.id ? `${ROOT}/${encodeURIComponent(String(input.id))}` : ROOT, input),
    editShared: async (code, input) => shared(code, await post<ShareRead>(sharePath(code), input)),
    remove: (id, revision) => post(`${ROOT}/${encodeURIComponent(id)}`, {remove: true, expected_revision: revision}),
    share: async record => {(await import('./sharing-sheet')).openSharing(record.id, {title: record.label, anchor: document.activeElement});},
    copyLink: async record => {
      const url = record.share_code ? new URL(`/share/${encodeURIComponent(record.share_code)}`, location.origin)
        : new URL(record.open_path, location.origin);
      if (record.share_code && accessCode) url.searchParams.set('access_code', accessCode);
      if (url.origin !== location.origin) throw new Error('This configuration link is invalid.');
      await navigator.clipboard.writeText(url.href);
      notify('Configuration link copied', {kind: 'done'});
    },
  };
}
