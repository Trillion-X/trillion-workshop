// parts/ui/show/sharing-sheet/SharingSheet.tsx
//
// PURPOSE
//   The one sharing sheet for every screen; a screen that adds its own sharing sheet repeats it. Whatever is being shared,
//   a caller hands in DATA and gets the same sheet. On top, the
//   preview of exactly what others will see (a picture, or a title and the fields that go, each with its label). Then
//   where it goes: places to pick on or off (a network, spaces, people) and places that open at once (an app, a
//   message); then, when the thing has fields, which of them go; then the caller's switch for the things linked to it;
//   then the caller's own buttons and Save.
//   For anything that can be opened by other people the caller may add, all as DATA: an invite row (a name, email or
//   number, a role, Invite), who has access now (each person or link with their role and a way to take it back), general
//   access (one choice of who else can open it: only the people added, anyone with the link, anyone and found in
//   search) and More choices (until when, how many opens, the link's own address, any option the caller names). Roles,
//   general-access choices and options are the caller's rows; the sheet never knows what they mean.
//   Anatomy from Notion's share menu (people with their access, then general access; Mobbin
//   f70f3807-8825-4a81-926f-54447ffa0665) and 21st.dev's Share Dialog (26993: invite people, choose what each can do,
//   and one line for who else can open it), with Strava's share sheet (the picture first, the places after) for a card.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The preview is never computed here: `previewFor(leaveOut)` asks the caller, whose answer is the same copy the
//      share makes, so the sheet cannot show a field that would not go or hide one that would.
//   2. Places, fields and words are the caller's DATA; a new kind of place is a row, never a change here.
//   3. Nothing changes until Save (picked places, fields, the chain switch); a place with `href` acts at once through
//      `onOpen`, and a caller's action runs when pressed. Invite, a role, a removal, general access and an option act
//      at once through the caller's own function, each pending and failing inside its own control.
//   4. A lock row (`lock`) is the caller's switch that keeps the thing to the person's own devices: turning it may first
//      ask for a secret in place (and once more when it is being set), which goes only to the caller's `change`; the
//      sheet keeps no copy of it after the change is made. While the caller says why it cannot turn (`blocked`), it
//      shows that instead of turning.
//   5. A history (`history`) is the caller's rows of what happened to the thing (who checked it, when), shown as given.
//   6. Every control is a shared one (Button, Switch, NamedIcon, Logo); how it looks is screen-look/show/guide.css
//      (`.sharing-sheet*`).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../coss/ui/button';
import { Logo } from '../coss/logo';
import { Switch } from '../switch/Switch';
import { NamedIcon } from '../icon/NamedIcon';
import { notify } from '../coss/notifications';
import { Input } from '../coss/ui/input';
import { DatePicker } from '../date-picker/DatePicker';
import { Badge } from '../coss/ui/badge';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type SharingPreview = {
  image?: { src: string; alt: string; width?: number; height?: number };
  title?: string | null;
  fields?: { id: string; label: string; value: string }[];
};
/** A place: picked on or off, or, with `href`, one that opens at once when pressed. */
export type SharingPlace = { id: string; label: string; icon?: string; logo?: string; picked?: boolean; href?: string };
/** One field of the shared thing. `match_only` present (true or false) offers a third way between going and staying out:
 *  it goes only as a mark, so copies holding the same value match while the value itself is never shown. */
export type SharingField = { id: string; label: string; included: boolean; match_only?: boolean };
export type SharingAction = { id: string; label: string; icon?: string; primary?: boolean; run: () => Promise<void> | void };
export type SharingChoice = { picked: string[]; leave_out: string[]; match_only: string[]; chain: boolean };
export type SharingWords = { preview: string; places: string; fields?: string; save?: string; saved?: string; failed: string; access?: string; general?: string; more?: string; fewer?: string;
  /** How a field can go, when matching is offered: as it is, only to match (with what the preview shows instead), or not at all. */
  field_ways?: { goes: string; match: string; out: string; shown_as_match: string } };
/** A role a person or link can have (what they may do), in the caller's words. */
export type SharingRole = { id: string; label: string };
/** The invite row: what is typed (a name, email or number) and the role chosen go to `invite`. */
export type SharingInvite = { label: string; placeholder: string; roles?: SharingRole[]; role?: string; invite: (value: string, role: string | null) => Promise<void> };
/** One person, place or link that can open the thing now. */
export type SharingAccessRow = {
  id: string; label: string; detail?: string; badge?: string; icon?: string;
  /** Their role: a choice when `change` is given, else shown as words. */
  role?: { value: string; choices: SharingRole[]; change?: (role: string) => Promise<void> };
  remove?: { label: string; run: () => Promise<void> };
};
/** Who else can open it: one of the caller's choices, changed at once. */
export type SharingGeneral = { value: string; choices: { id: string; label: string; detail: string; icon: string }[]; change: (id: string) => Promise<void> };
/** One More choices option, saved when it is left (a date, a number, words or a switch). */
export type SharingOption = { id: string; label: string; kind: 'date' | 'number' | 'text' | 'switch'; value: string | number | boolean | null; placeholder?: string; detail?: string; change: (value: string | number | boolean | null) => Promise<void> };

/** Keeping the thing to the person's own devices: a switch that may first ask for a secret (invariant 4). */
export type SharingLock = {
  label: string; detail?: string; on: boolean; blocked?: string | null;
  ask?: { label: string; again?: string; go: string; differ: string } | null;
  change: (on: boolean, secret?: string) => Promise<void>;
};
/** What happened to the thing, newest first, as the caller words it (invariant 5). */
export type SharingHistory = { heading: string; rows: { id: string; label: string; detail?: string; icon?: string }[] };

export type SharingSheetProps = {
  preview: SharingPreview;
  places: SharingPlace[];
  fields?: SharingField[];
  chain?: { label: string; on: boolean } | null;
  words: SharingWords;
  /** The copy others would see with these fields left out (invariant 1). */
  previewFor?: (leaveOut: string[]) => Promise<SharingPreview>;
  onSave?: (choice: SharingChoice) => Promise<void>;
  onOpen?: (place: SharingPlace) => Promise<void> | void;
  actions?: SharingAction[];
  /** Places switched on to start with that are not saved yet (Share pressed inside a space starts with that space). */
  proposed?: string[];
  invite?: SharingInvite;
  access?: SharingAccessRow[];
  general?: SharingGeneral;
  options?: SharingOption[];
  lock?: SharingLock | null;
  history?: SharingHistory | null;
};

const same = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));

function Mark({ place }: { place: SharingPlace }) {
  return place.logo ? <Logo src={place.logo} name={place.label} className="sharing-sheet-mark" /> : <NamedIcon name={place.icon ?? 'Send'} className="sharing-sheet-mark" aria-hidden />;
}

/** One shared copy under its heading: a picture, or its title and each field with its label. The sheet shows the
 *  copy others will see this way, and a person reading what someone shared with them sees it the same way. */
// A field the caller gave no label for (its label is still its id) is Trillion's own, like a file's identity: the
// person never sees it.
const labelled = (fields: { id: string; label: string; value: string }[] | undefined) => (fields ?? []).filter(field => field.label && field.label !== field.id);

export function SharedCopy({ heading, preview }: { heading: string; preview: SharingPreview }) {
  return (
    <section className="sharing-sheet-section" aria-label={heading}>
      <p className="sharing-sheet-heading">{heading}</p>
      {preview.image
        ? <img className="sharing-sheet-picture" src={preview.image.src} alt={preview.image.alt} width={preview.image.width} height={preview.image.height} />
        : (
          <div className="sharing-sheet-preview">
            {preview.title ? <p className="sharing-sheet-preview-title">{preview.title}</p> : null}
            {labelled(preview.fields).length ? (
              <dl className="sharing-sheet-preview-fields">
                {labelled(preview.fields).map(field => (
                  <div key={field.id} className="sharing-sheet-preview-field">
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        )}
    </section>
  );
}

function RoleChoice({ role, label, busy, choose }: { role: NonNullable<SharingAccessRow['role']>; label: string; busy: boolean; choose: (id: string) => void }) {
  const named = role.choices.find(choice => choice.id === role.value)?.label ?? role.value;
  if (!role.change || role.choices.length < 2) return <span className="sharing-sheet-role">{named}</span>;
  return (
    <Select value={role.value} disabled={busy} onValueChange={value => { if (typeof value === 'string' && value !== role.value) choose(value); }}>
      <SelectTrigger size="sm" className="sharing-sheet-role-choice" aria-label={label}><SelectValue>{named}</SelectValue></SelectTrigger>
      <SelectPopup>{role.choices.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}</SelectPopup>
    </Select>
  );
}

function InviteRow({ invite, busy, run }: { invite: SharingInvite; busy: boolean; run: (work: () => Promise<void>) => Promise<boolean> }) {
  const [value, setValue] = useState('');
  const [role, setRole] = useState<string | null>(invite.role ?? invite.roles?.[0]?.id ?? null);
  const send = async () => { if (value.trim() && await run(() => invite.invite(value.trim(), role))) setValue(''); };
  return (
    <div className="sharing-sheet-invite" role="group" aria-label={invite.label}>
      <Input className="sharing-sheet-invite-field" value={value} placeholder={invite.placeholder} aria-label={invite.placeholder} disabled={busy}
        onChange={event => setValue((event.target as HTMLInputElement).value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void send(); } }} />
      {invite.roles && invite.roles.length > 1 ? (
        <Select value={role ?? undefined} disabled={busy} onValueChange={next => { if (typeof next === 'string') setRole(next); }}>
          <SelectTrigger className="sharing-sheet-role-choice" aria-label={`${invite.label}: role`}><SelectValue>{invite.roles.find(choice => choice.id === role)?.label}</SelectValue></SelectTrigger>
          <SelectPopup>{invite.roles.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}</SelectPopup>
        </Select>
      ) : null}
      <Button variant="outline" loading={busy} disabled={!value.trim()} onClick={() => send()}><NamedIcon name="UserPlus" aria-hidden />{invite.label}</Button>
    </div>
  );
}

// An option keeps what is typed until it is left, then saves it once; a switch saves when it is turned.
function OptionRow({ option, busy, run }: { option: SharingOption; busy: boolean; run: (work: () => Promise<void>) => Promise<boolean> }) {
  const shown = option.value === null || option.value === undefined ? '' : String(option.value);
  const [typed, setTyped] = useState(shown);
  useEffect(() => setTyped(shown), [shown]);
  const leave = () => {
    if (typed === shown) return;
    const value = typed === '' ? null : option.kind === 'number' ? Number(typed) : typed;
    void run(() => option.change(value)).then(ok => { if (!ok) setTyped(shown); });
  };
  if (option.kind === 'switch') return (
    <div className="sharing-sheet-row sharing-sheet-stacked">
      <span className="sharing-sheet-label">{option.label}{option.detail ? <span className="sharing-sheet-detail">{option.detail}</span> : null}</span>
      <Switch checked={option.value === true} label={option.label} disabled={busy} onCheckedChange={on => void run(() => option.change(on))} />
    </div>
  );
  return (
    <label className="sharing-sheet-option">
      <span className="sharing-sheet-label">{option.label}{option.detail ? <span className="sharing-sheet-detail">{option.detail}</span> : null}</span>
      {option.kind === 'date' ? <DatePicker className="sharing-sheet-option-field" aria-label={option.label} value={typed || null} placeholder={option.placeholder} disabled={busy}
        onChange={day => { if ((day ?? '') === shown) return; setTyped(day ?? ''); void run(() => option.change(day)).then(ok => { if (!ok) setTyped(shown); }); }} /> : <Input className="sharing-sheet-option-field" size="sm" type={option.kind} value={typed} placeholder={option.placeholder} disabled={busy}
        aria-label={option.label} onChange={event => setTyped((event.target as HTMLInputElement).value)} onBlur={leave}
        onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />}
    </label>
  );
}

// The lock row: turning it asks for the secret in place when the caller needs one, then makes the change.
function LockRow({ lock, busy, run }: { lock: SharingLock; busy: boolean; run: (work: () => Promise<void>) => Promise<boolean> }) {
  const [asking, setAsking] = useState<boolean | null>(null);
  const [secret, setSecret] = useState('');
  const [again, setAgain] = useState('');
  const close = () => { setAsking(null); setSecret(''); setAgain(''); };
  const turn = (on: boolean) => {
    if (lock.blocked) { notify(lock.blocked, { kind: 'error' }); return; }
    if (lock.ask) { setAsking(on); return; }
    void run(() => lock.change(on));
  };
  const go = async () => {
    if (asking === null || !secret) return;
    if (lock.ask?.again && secret !== again) { notify(lock.ask.differ, { kind: 'error' }); return; }
    if (await run(() => lock.change(asking, secret))) close();
  };
  const enter = (event: React.KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); void go(); } };
  return (
    <section className="sharing-sheet-section" aria-label={lock.label}>
      <div className="sharing-sheet-row sharing-sheet-stacked">
        <NamedIcon name={lock.on ? 'Lock' : 'LockOpen'} className="sharing-sheet-mark" aria-hidden />
        <span className="sharing-sheet-label">{lock.label}<span className="sharing-sheet-detail">{lock.blocked ?? lock.detail}</span></span>
        <Switch checked={asking ?? lock.on} label={lock.label} disabled={busy} onCheckedChange={turn} />
      </div>
      {asking !== null && lock.ask ? (
        <div className="sharing-sheet-invite" role="group" aria-label={lock.ask.label}>
          <Input className="sharing-sheet-invite-field" type="password" autoComplete="current-password" autoFocus value={secret} placeholder={lock.ask.label} aria-label={lock.ask.label} disabled={busy}
            onChange={event => setSecret((event.target as HTMLInputElement).value)} onKeyDown={enter} />
          {lock.ask.again ? (
            <Input className="sharing-sheet-invite-field" type="password" autoComplete="new-password" value={again} placeholder={lock.ask.again} aria-label={lock.ask.again} disabled={busy}
              onChange={event => setAgain((event.target as HTMLInputElement).value)} onKeyDown={enter} />
          ) : null}
          <Button variant="outline" loading={busy} disabled={!secret} onClick={() => go()}><NamedIcon name="KeyRound" aria-hidden />{lock.ask.go}</Button>
        </div>
      ) : null}
    </section>
  );
}

export function SharingSheet({ preview, places, fields = [], chain = null, words, previewFor, onSave, onOpen, actions = [], proposed = [], invite, access = [], general, options = [], lock = null, history = null }: SharingSheetProps) {
  const pickable = places.filter(place => !place.href);
  const opening = places.filter(place => place.href);
  const startPicked = useMemo(() => places.filter(place => !place.href && place.picked).map(place => place.id), [places]);
  const startLeftOut = useMemo(() => fields.filter(field => !field.included).map(field => field.id), [fields]);
  const startMatchOnly = useMemo(() => fields.filter(field => field.match_only === true).map(field => field.id), [fields]);
  const proposedKey = proposed.join('\n');
  const [picked, setPicked] = useState(() => [...new Set([...startPicked, ...proposed])]);
  const [leftOut, setLeftOut] = useState(startLeftOut);
  const [matchOnly, setMatchOnly] = useState(startMatchOnly);
  const [linked, setLinked] = useState(chain?.on ?? false);
  const [shown, setShown] = useState(preview);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const asked = useRef(0);

  // A newer sheet from the caller starts over from what it says.
  useEffect(() => { setPicked([...new Set([...startPicked, ...proposed])]); setLeftOut(startLeftOut); setMatchOnly(startMatchOnly); setLinked(chain?.on ?? false); setShown(preview); }, [preview, startPicked, startLeftOut, startMatchOnly, chain?.on, proposedKey]);

  // Every act shows pending in its own control and says a failure; answers whether it went through.
  const run = async (id: string, work: () => Promise<void> | void): Promise<boolean> => {
    setBusy(id);
    try { await work(); return true; } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') notify(errorWords(error, words.failed), { kind: 'error' });
      return false;
    } finally { setBusy(null); }
  };
  // A field goes as it is, only as a mark, or not at all; only leaving it out changes the copy the store makes.
  const chooseWay = (id: string, way: string) => {
    setMatchOnly(way === 'match' ? [...matchOnly.filter(item => item !== id), id] : matchOnly.filter(item => item !== id));
    const next = way === 'out' ? [...leftOut.filter(item => item !== id), id] : leftOut.filter(item => item !== id);
    if (same(next, leftOut)) return;
    setLeftOut(next);
    if (!previewFor) return;
    const turn = ++asked.current;
    previewFor(next).then(answer => { if (turn === asked.current) setShown(answer); }, error => notify(errorWords(error, words.failed), { kind: 'error' }));
  };
  const changed = !same(picked, startPicked) || !same(leftOut, startLeftOut) || !same(matchOnly, startMatchOnly) || linked !== (chain?.on ?? false);
  const ways = words.field_ways;
  const seen = ways && matchOnly.length ? { ...shown, fields: shown.fields?.map(field => (matchOnly.includes(field.id) ? { ...field, value: ways.shown_as_match } : field)) } : shown;

  return (
    <div className="sharing-sheet" data-slot="sharing-sheet">
      {lock?.on ? null : <SharedCopy heading={words.preview} preview={seen} />}

      {lock ? <LockRow lock={lock} busy={busy === 'lock'} run={work => run('lock', work)} /> : null}

      {invite ? <InviteRow invite={invite} busy={busy === 'invite'} run={work => run('invite', work)} /> : null}

      {access.length ? (
        <section className="sharing-sheet-section" aria-label={words.access}>
          {words.access ? <p className="sharing-sheet-heading">{words.access}</p> : null}
          {access.map(row => (
            <div key={row.id} className="sharing-sheet-row sharing-sheet-person" data-busy={busy === `access:${row.id}` ? 'true' : undefined}>
              <NamedIcon name={row.icon ?? 'User'} className="sharing-sheet-mark" aria-hidden />
              <span className="sharing-sheet-label">
                <span className="sharing-sheet-name">{row.label}{row.badge ? <Badge variant="outline" className="sharing-sheet-badge">{row.badge}</Badge> : null}</span>
                {row.detail ? <span className="sharing-sheet-detail">{row.detail}</span> : null}
              </span>
              {row.role ? <RoleChoice role={row.role} label={`${row.label}: role`} busy={busy === `access:${row.id}`} choose={id => void run(`access:${row.id}`, () => row.role!.change!(id))} /> : null}
              {row.remove ? (
                <Button variant="ghost" size="icon-sm" aria-label={`${row.remove.label}: ${row.label}`} title={row.remove.label} loading={busy === `remove:${row.id}`} onClick={() => run(`remove:${row.id}`, row.remove!.run)}>
                  <NamedIcon name="Trash2" aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {general ? (
        <section className="sharing-sheet-section" aria-label={words.general}>
          {words.general ? <p className="sharing-sheet-heading">{words.general}</p> : null}
          <div className="sharing-sheet-general" data-busy={busy === 'general' ? 'true' : undefined}>
            <NamedIcon name={general.choices.find(choice => choice.id === general.value)?.icon ?? 'Lock'} className="sharing-sheet-general-mark" aria-hidden />
            <span className="sharing-sheet-label">
              <Select value={general.value} disabled={busy === 'general'} onValueChange={value => { if (typeof value === 'string' && value !== general.value) void run('general', () => general.change(value)); }}>
                <SelectTrigger size="sm" className="sharing-sheet-general-choice" aria-label={words.general}><SelectValue>{general.choices.find(choice => choice.id === general.value)?.label}</SelectValue></SelectTrigger>
                <SelectPopup>{general.choices.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}</SelectPopup>
              </Select>
              <span className="sharing-sheet-detail">{general.choices.find(choice => choice.id === general.value)?.detail}</span>
            </span>
          </div>
        </section>
      ) : null}

      {pickable.length || opening.length ? <section className="sharing-sheet-section" aria-label={words.places}>
        <p className="sharing-sheet-heading">{words.places}</p>
        {pickable.map(place => (
          <div key={place.id} className="sharing-sheet-row">
            <Mark place={place} />
            <span className="sharing-sheet-label">{place.label}</span>
            <Switch checked={picked.includes(place.id)} label={place.label} onCheckedChange={on => setPicked(on ? [...picked, place.id] : picked.filter(id => id !== place.id))} />
          </div>
        ))}
        {opening.length ? (
          <div className="sharing-sheet-places" role="group" aria-label={words.places}>
            {opening.map(place => (
              <Button key={place.id} variant="ghost" className="sharing-sheet-place" loading={busy === place.id} onClick={() => run(place.id, () => onOpen?.(place))}>
                <Mark place={place} />
                <span>{place.label}</span>
              </Button>
            ))}
          </div>
        ) : null}
      </section> : null}

      {fields.length ? (
        <section className="sharing-sheet-section" aria-label={words.fields}>
          <p className="sharing-sheet-heading">{words.fields}</p>
          {fields.map(field => (
            <div key={field.id} className="sharing-sheet-row">
              <span className="sharing-sheet-label">{field.label}</span>
              {ways && field.match_only !== undefined ? (
                <Select value={leftOut.includes(field.id) ? 'out' : matchOnly.includes(field.id) ? 'match' : 'goes'} onValueChange={way => { if (typeof way === 'string') chooseWay(field.id, way); }}>
                  <SelectTrigger size="sm" className="sharing-sheet-role-choice" aria-label={`${field.label}: how it goes`}><SelectValue>{ways[leftOut.includes(field.id) ? 'out' : matchOnly.includes(field.id) ? 'match' : 'goes']}</SelectValue></SelectTrigger>
                  <SelectPopup>{(['goes', 'match', 'out'] as const).map(way => <SelectItem key={way} value={way}>{ways[way]}</SelectItem>)}</SelectPopup>
                </Select>
              ) : <Switch checked={!leftOut.includes(field.id)} label={field.label} onCheckedChange={on => chooseWay(field.id, on ? 'goes' : 'out')} />}
            </div>
          ))}
        </section>
      ) : null}

      {chain ? (
        <div className="sharing-sheet-row">
          <NamedIcon name="Link2" className="sharing-sheet-mark" aria-hidden />
          <span className="sharing-sheet-label">{chain.label}</span>
          <Switch checked={linked} label={chain.label} onCheckedChange={setLinked} />
        </div>
      ) : null}

      {history?.rows.length ? (
        <section className="sharing-sheet-section" aria-label={history.heading}>
          <p className="sharing-sheet-heading">{history.heading}</p>
          {history.rows.map(row => (
            <div key={row.id} className="sharing-sheet-row sharing-sheet-stacked">
              <NamedIcon name={row.icon ?? 'History'} className="sharing-sheet-mark" aria-hidden />
              <span className="sharing-sheet-label">{row.label}{row.detail ? <span className="sharing-sheet-detail">{row.detail}</span> : null}</span>
            </div>
          ))}
        </section>
      ) : null}

      {options.length ? (
        <section className="sharing-sheet-section sharing-sheet-more" aria-label={words.more}>
          <Button variant="ghost" size="sm" className="sharing-sheet-more-toggle" aria-expanded={more} onClick={() => setMore(!more)}>
            <NamedIcon name={more ? 'ChevronDown' : 'ChevronRight'} aria-hidden />{more ? (words.fewer ?? words.more) : words.more}
          </Button>
          {more ? options.map(option => <OptionRow key={option.id} option={option} busy={busy === `option:${option.id}`} run={work => run(`option:${option.id}`, work)} />) : null}
        </section>
      ) : null}

      {actions.length || onSave ? (
        <div className="sharing-sheet-actions">
          {actions.map(action => (
            <Button key={action.id} variant={action.primary ? 'default' : 'outline'} loading={busy === action.id} onClick={() => run(action.id, action.run)}>
              {action.icon ? <NamedIcon name={action.icon} aria-hidden /> : null}{action.label}
            </Button>
          ))}
          {onSave && (pickable.length || fields.length || chain) ? (
            <Button variant="outline" disabled={!changed} loading={busy === 'save'} onClick={() => run('save', async () => {
              await onSave({ picked, leave_out: leftOut, match_only: matchOnly, chain: linked });
              if (words.saved) notify(words.saved, { kind: 'done' });
            })}>{words.save}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
