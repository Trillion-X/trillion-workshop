// src/workspace/show-rules-admin-screen.tsx
//
// Purpose
//   The admin's screen for how other accounts see Trillion: pick one of the presets this person keeps (the `types` of
//   their own show-rules record) and share it with people. A share is two ordinary workspace records, written through
//   the generic records write like any other: the preset's copy (show-rules.json `sharing.record_prefix` + preset id:
//   { label, types }, the preset with every preset it inherits) and its grant (record-sharing.json
//   `door_grant.record_prefix` + that label: { record, people: [{ principal, key_blake3 }], changed_at }), which the
//   person's own door honors for each person's share key (trillion-rust src/account_rights/share_grant.rs). The people
//   a preset is shared with are its group; one person is one account.
//
// Non-negotiable invariants
//   1. Nothing here names a preset, a rule or a person: presets are the person's record, words are show-rules.json
//      `sharing.words`, prefixes are DATA.
//   2. A share key is made here, put on the clipboard once on the admin's press, and never drawn or kept: the grant
//      keeps only its BLAKE3, so reading the grant never discloses a usable key.
//   3. The preset's copy is written before its grant names anyone, so a key never reaches a record that is not there.
//   4. Every write is a compare-and-retry over the record as the store holds it now (updateSavedLabelValueDurably).
//
// Key concepts
//   - Anatomy is the one sharing sheet (parts/ui/show/sharing-sheet): the preview of what they get, the invite row,
//     and who it is shared with, each with a way to stop.
import * as React from 'react';
import { makeHashCodeHexFromBytes } from '../../../../content-identity/read-data/identity.mjs';
import { Button, Card, Container, Dropdown, EmptyPlaceholder, Text } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { SharingSheet, type SharingPreview } from '../../parts/ui/show/sharing-sheet/SharingSheet';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import data from '../../../../set-up-my-account/read-data/show-rules.json';
import sharing from '../record-sharing.json';
import { typesOf } from './show-rules.mjs';
import { readSavedRecordFromOwner, updateSavedLabelValueDurably } from './records';
import { refusal } from './failure';

type Preset = { id: string; label: string; inherits?: string[]; rules?: unknown[] };
type Person = { principal: string; key_blake3: string };
type Grant = { record: string; people: Person[]; changed_at: string };

const words = data.sharing.words;
const KEY_BYTES = 32;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
const copyLabel = (preset: Preset) => `${data.sharing.record_prefix}${preset.id}`;
const grantLabel = (label: string) => `${sharing.door_grant.record_prefix}${label}`;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The presets the person keeps now, read from the store, never from this page's cache. */
async function readPresets(): Promise<Preset[]> {
  const kept = await readSavedRecordFromOwner(data.record);
  return typesOf(kept.found ? kept.value : null) as Preset[];
}

/** The preset with every preset it inherits, each once, so the copy stands on its own. */
function withInherited(preset: Preset, presets: Preset[]): Preset[] {
  const byId = new Map(presets.map(each => [each.id, each]));
  const taken = new Map<string, Preset>();
  const take = (each: Preset | undefined) => {
    if (!each || taken.has(each.id)) return;
    taken.set(each.id, each);
    (each.inherits ?? []).forEach(id => take(byId.get(id)));
  };
  take(preset);
  return [...taken.values()];
}

/** The people a grant names, read as the store holds it; anything that is not a grant names nobody. */
const peopleOf = (value: unknown): Person[] => (object(value) && Array.isArray(value.people)
  ? value.people.filter((person): person is Person => object(person) && typeof person.principal === 'string' && typeof person.key_blake3 === 'string')
  : []);

/** A new share key: the door's token prefix and 32 random bytes, base64url. */
function newShareKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const text = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${sharing.door_grant.token_prefix}${text}`;
}

function previewOf(preset: Preset, presets: Preset[]): SharingPreview {
  const inherited = withInherited(preset, presets).filter(each => each.id !== preset.id);
  return {
    title: preset.label,
    fields: [
      { id: 'rules', label: words.rules, value: String(preset.rules?.length ?? 0) },
      ...(inherited.length ? [{ id: 'inherits', label: words.inherits, value: inherited.map(each => each.label).join(', ') }] : []),
    ],
  };
}

function ShowRulesAdmin() {
  const loaded = useScreenLoad<Preset[]>('show-rules-admin', { loading: { label: words.loading, layout: 'rows' }, read: readPresets, failed: refusal(words.failed) });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <PresetSharing presets={loaded.value} />;
}

function PresetSharing({ presets }: { presets: Preset[] }) {
  const [presetId, setPresetId] = React.useState(presets[0]?.id ?? '');
  const [people, setPeople] = React.useState<Person[]>([]);
  // The key made for the last person added, held only in this page until the admin copies it.
  const [fresh, setFresh] = React.useState<{ principal: string; key: string } | null>(null);
  const [said, setSaid] = React.useState('');
  const preset = presets.find(each => each.id === presetId) ?? null;

  React.useEffect(() => {
    if (!preset) return;
    let active = true;
    setPeople([]);
    void readSavedRecordFromOwner(grantLabel(copyLabel(preset))).then(
      grant => { if (active) setPeople(grant.found ? peopleOf(grant.value) : []); },
      error => { if (active) notify(errorWords(error, words.failed), { kind: 'error' }); });
    return () => { active = false; };
  }, [preset]);

  const preview = React.useMemo(() => (preset ? previewOf(preset, presets) : { title: null }), [preset, presets]);

  if (!preset) return <Container layout="vertical" gap="md" padding="md">
    <Heading />
    <EmptyPlaceholder title={words.none} />
  </Container>;

  const label = copyLabel(preset);
  /** Change who the grant names, over the grant as the store holds it now, and show the people it names after. */
  const changeGrant = async (change: (now: Person[]) => Person[]) => {
    const written = await updateSavedLabelValueDurably<Grant>(grantLabel(label), current => ({ record: label, people: change(peopleOf(current)), changed_at: new Date().toISOString() }));
    setPeople(written.people);
  };

  // A refusal is said beside the sheet as well as by the sheet's own notice, and keeps what was typed.
  const invite = async (principal: string) => {
    if (people.some(person => person.principal === principal)) {
      const already = fill(words.already, { principal });
      setSaid(already);
      throw new Error(already);
    }
    try { await share(principal); } catch (error) { setSaid(errorWords(error, words.share_failed)); throw error; }
  };
  const share = async (principal: string) => {
    const key = newShareKey();
    const key_blake3 = makeHashCodeHexFromBytes(new TextEncoder().encode(key)).slice(3);
    await updateSavedLabelValueDurably(label, () => ({ label: preset.label, types: withInherited(preset, presets) }));
    await changeGrant(now => [...now.filter(person => person.principal !== principal), { principal, key_blake3 }]);
    setFresh({ principal, key });
    setSaid(fill(words.added, { principal }));
  };

  const copyFresh = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.key);
      setSaid(fill(words.copied, { principal: fresh.principal }));
      setFresh(null);
    } catch (error) { notify(errorWords(error, words.share_failed), { kind: 'error' }); }
  };

  return <Container layout="vertical" gap="md" padding="md">
    <Heading />
    <Card variant="surface" padding="md">
      <Container layout="vertical" gap="md">
        <Container layout="vertical" gap="xs">
          <Text variant="body-xs" color="secondary">{words.preset}</Text>
          <Dropdown aria-label={words.preset} value={presetId} onValueChange={setPresetId} items={presets.map(each => ({ value: each.id, label: each.label }))} />
        </Container>
        <SharingSheet
          preview={preview}
          places={[]}
          words={{ preview: words.preview, places: '', failed: words.share_failed, access: words.access }}
          invite={{ label: words.invite, placeholder: words.placeholder, invite: principal => invite(principal) }}
          access={people.map(person => ({ id: person.principal, label: person.principal, icon: 'User',
            remove: { label: words.remove, run: () => changeGrant(now => now.filter(each => each.principal !== person.principal)) } }))}
        />
        <Container layout="horizontal" gap="sm" alignItems="center" wrap>
          <Text variant="caption" color="muted" role="status" aria-live="polite">{said}</Text>
          {fresh ? <Button size="sm" variant="primary" onClick={() => copyFresh()}>{words.copy}</Button> : null}
        </Container>
      </Container>
    </Card>
  </Container>;
}

function Heading() {
  return <Container layout="vertical" gap="xs">
    <Text variant="heading-sm" as="h1">{words.heading}</Text>
    <Text variant="body" color="secondary">{words.about}</Text>
  </Container>;
}

export function mountShowRulesAdminScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <ShowRulesAdmin />);
}
