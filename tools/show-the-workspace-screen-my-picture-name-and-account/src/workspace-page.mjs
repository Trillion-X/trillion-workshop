// src/workspace-page.mjs
//
// Purpose
//   The Workspace screen (src/account-routes.mjs screens.workspace): an overview (picture, name, account), the summary
//   templates (stock and the person's own), the person's profile
//   details (birthday, location, Delete account) and a Members table with an invite-by-email form. The details are one
//   account fact (src/workspace-page.json `fact`); the people are the ones who share a pursuit with the person, read from
//   the pursuits the person's store lists, and an invite is the invitation Spaces already sends (src/person-spaces.mjs
//   invite-person). Words and limits are DATA (src/workspace-page.json).
//
// Non-negotiable invariants
//   1. Only real rows: a member is a name some pursuit of this person shows; a list that could not be read says so, it
//      is never an empty table.
//   2. A birthday is kept only as a real calendar day not in the future; a name and a location are cut to the DATA's
//      lengths. Nothing here is shown to anyone but the person.
//   3. The picture is the identity of a file the person keeps (checked to be a picture by the store before it is kept); a
//      template of the person's own is a snippet under the note review's tag, so the picker there and the list here
//      are one list.
//   4. An invite goes into a pursuit this person is in (the pursuit's own invite road enforces its rules); this file
//      makes no invitation of its own.
//
import settings from '../../shared-code/src/workspace-page.json' with { type: 'json' };
import review from './workspace/meeting-review.json' with { type: 'json' };

export const WORKSPACE_PAGE = settings;
export const WORKSPACE_FACT = settings.fact;
export const TEMPLATE_TAG = review.summary_tools.own_tag;
const FILE_IDENTITY = /^(?:1f|12):[0-9a-f]{64}$/;

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The details kept, or what the form sent turned into them: throws an Error in plain words for a birthday that is not a day. */
export function detailsFrom(kept, values = {}, now = new Date()) {
  const next = { ...(kept && typeof kept === 'object' ? kept : {}) };
  if ('name' in values) {
    const name = text(values.name, settings.name_max);
    if (!name) throw new Error(settings.words.need_name);
    next.name = name;
  }
  if ('birthday' in values) {
    const typed = text(values.birthday, 10);
    if (typed) {
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typed);
      const made = day ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) : null;
      if (!made || made.toISOString().slice(0, 10) !== typed || made > now) throw new Error(settings.words.bad_birthday);
      next.birthday = typed;
    } else delete next.birthday;
  }
  if ('location' in values) {
    const place = text(values.location, settings.location_max);
    if (place) next.location = place; else delete next.location;
  }
  return next;
}

/** The details with the picture kept (a file identity) or taken off (null): throws an Error in plain words for anything else. */
export function withAvatar(kept, identity) {
  const next = { ...(kept && typeof kept === 'object' ? kept : {}) };
  if (identity === null) { delete next.avatar; return next; }
  if (typeof identity !== 'string' || !FILE_IDENTITY.test(identity)) throw new Error(settings.words.need_avatar);
  next.avatar = identity;
  return next;
}

/** A template of the person's own as the form sent it: { id?, title, text } cut to the DATA's lengths, or an Error in plain words. */
export function templateFrom(values = {}, id = '') {
  const title = text(values.name, settings.template_name_max);
  const asked = typeof values.text === 'string' ? values.text.trim().slice(0, settings.template_text_max) : '';
  if (!title) throw new Error(settings.words.need_template_name);
  if (!asked) throw new Error(settings.words.need_template_text);
  return { ...(typeof id === 'string' && id ? { snippet_id: id } : {}), title, text: asked, tags: [TEMPLATE_TAG] };
}

/** The templates section: the stock ones (read only), then the person's own, each openable to change or remove, and a form to create one. `own` is [{ snippet_id, title, text }] or null when they could not be read. */
function templatesSection(own) {
  const words = settings.words;
  const fields = row => [
    { name: 'name', label: words.template_name_label, secret: false, value: row?.title ?? '' },
    { name: 'text', label: words.template_text_label, kind: 'text', placeholder: words.template_text_placeholder, value: row?.text ?? '' },
  ];
  const save = id => [{ label: words.template_save, tone: 'primary', send: { path: '/work/api/workspace/template', ...(id ? { body: { id } } : {}), with_fields: true } }];
  return {
    id: 'templates', heading: words.templates_heading, body: words.templates_body,
    rows: [
      ...review.summary_tools.templates.map(template => ({ id: `stock:${template.id}`, title: template.label, status: { label: words.template_stock_tag }, detail: template.ask || words.template_general })),
      ...(own ?? []).map(template => ({
        id: template.snippet_id, title: template.title, status: { label: words.template_own_tag }, detail: template.text, open_label: words.template_edit_open,
        fields: fields(template), actions: [...save(template.snippet_id), { label: words.template_remove, tone: 'quiet', send: { path: '/work/api/workspace/template/remove', body: { id: template.snippet_id }, confirm: words.template_remove_confirm } }],
      })),
      ...(own ? [{ id: 'new-template', title: words.template_new_title, open_label: words.template_new_open, starts_open: !own.length, fields: fields(null), actions: save('') }] : []),
    ],
    note: own ? (own.length ? undefined : words.templates_none) : words.templates_unreadable,
  };
}

/** What is kept, in a line: "Saved: Birthday 1990-04-23 · Location Oslo", or that nothing is. */
const savedWords = details => {
  const pairs = [details.birthday ? fill(settings.words.birthday_short, { value: details.birthday }) : null, details.location ? fill(settings.words.location_short, { value: details.location }) : null].filter(Boolean);
  return pairs.length ? fill(settings.words.profile_saved, { pairs: pairs.join(' · ') }) : settings.words.profile_none;
};

/** Everyone who shares a pursuit with the person, by name, with the pursuits they share: [{ name, pursuits: [title] }]. */
export function membersOf(spaces) {
  const byName = new Map();
  for (const space of spaces) for (const name of space.others ?? []) {
    if (typeof name !== 'string' || !name) continue;
    byName.set(name, [...(byName.get(name) ?? []), space.title]);
  }
  return [...byName].map(([name, pursuits]) => ({ name, pursuits })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The facts the Workspace screen draws (the Marketplace screen tool:workspace): its words, the account's name, the kept
 * details, the people who share a pursuit with the person (null when the pursuits could not be read) and the pursuits
 * the person is in, each with the address that opens it. `account` is the account's name, `details` the kept details,
 * `spaces` is [{ space_id, title, others }] or null.
 */
export function workspaceFacts({ account, details = {}, spaces, open_address: openAddress = () => null }) {
  const members = spaces ? membersOf(spaces) : null;
  return {
    words: settings.words,
    account: account || null,
    name: details.name || null,
    birthday: details.birthday ?? null,
    location: details.location ?? null,
    members,
    member_count: members ? members.length + 1 : null,
    spaces: spaces ? spaces.map(space => ({ space_id: space.space_id, title: space.title, open: openAddress(space) ?? null })) : null,
  };
}

/**
 * The screen. facts: { account (the account's name), details (the kept details), spaces ([{ space_id, title, others }] or
 * null when they could not be read), templates ([{ snippet_id, title, text }] or null when they could not be read) }.
 */
export function workspaceScreen({ account, details = {}, spaces, templates = null, open_address: openAddress = () => null }) {
  const words = settings.words;
  const members = spaces ? membersOf(spaces) : null;
  return {
    title: words.title,
    lead: words.lead,
    sections: [
      {
        id: 'overview', heading: words.overview_heading,
        profile: {
          name: details.name || words.default_name, tag: words.overview_tag, detail: account ? fill(words.account_line, { account }) : undefined,
          mark: details.avatar ? { picture: `${settings.avatar_address}${encodeURIComponent(details.avatar)}` } : { icon: 'Building2' },
          ...(spaces ? { facts: [{ label: words.members_heading, value: String(members.length + 1), icon: 'Users' }] } : {}),
        },
        ...(spaces ? { actions: [{ label: words.switch, icon: 'ChevronsUpDown', tone: 'quiet', learn: { title: words.switch_title, body: spaces.length ? words.switch_body : words.switch_none,
          steps: spaces.map(space => ({ title: space.title, ...(openAddress(space) ? { action: { label: words.switch_open, tone: 'quiet', open: openAddress(space) } } : {}) })) } }] } : {}),
        rows: [{
          id: 'avatar', title: words.avatar_title, detail: words.avatar_body, open_label: words.avatar_row,
          fields: [{ name: 'avatar', label: words.avatar_label, kind: 'file', takes: settings.avatar_takes, value: details.avatar ?? '' }],
          actions: [
            { label: words.avatar_save, tone: 'primary', send: { path: '/work/api/workspace/avatar', with_fields: true } },
            ...(details.avatar ? [{ label: words.avatar_remove, tone: 'quiet', send: { path: '/work/api/workspace/avatar/remove', confirm: words.avatar_remove_confirm } }] : []),
          ],
        }, {
          id: 'rename', title: words.rename, open_label: words.rename,
          fields: [{ name: 'name', label: words.rename_label, secret: false, value: details.name ?? '', placeholder: words.default_name }],
          actions: [{ label: words.save, tone: 'primary', send: { path: '/work/api/workspace/details', with_fields: true } }],
        }],
      },
      templatesSection(templates),
      {
        id: 'profile', heading: words.profile_heading, body: words.profile_body,
        rows: [{
          id: 'profile-details', title: words.profile_heading, starts_open: true, detail: savedWords(details),
          fields: [
            { name: 'birthday', label: words.birthday_label, secret: false, value: details.birthday ?? '', placeholder: words.birthday_placeholder },
            { name: 'location', label: words.location_label, secret: false, value: details.location ?? '', placeholder: words.location_placeholder },
          ],
          actions: [{ label: words.save, tone: 'primary', send: { path: '/work/api/workspace/details', with_fields: true } }],
        }, {
          id: 'account-page', title: words.account_heading, detail: words.delete_where,
          actions: [{ label: words.delete_open, tone: 'quiet', open: `settings-page:${words.account_page}` }],
        }],
      },
      {
        id: 'members', heading: words.members_heading, body: words.members_body,
        rows: [
          ...(members ?? []).map(member => ({ id: member.name, title: member.name, detail: fill(words.shared_in, { pursuits: member.pursuits.join(', ') }) })),
          ...(spaces ? [{
            id: 'invite-by-email', title: words.invite_title, open_label: words.invite_open, starts_open: !members.length,
            ...(spaces.length ? {
              fields: [
                { name: 'email', label: words.invite_email_label, secret: false, placeholder: words.invite_email_placeholder },
                { name: 'name', label: words.invite_name_label, secret: false },
                { name: 'pursuit', label: words.invite_pursuit_label, kind: 'choice', value: spaces[0].space_id, options: spaces.map(space => ({ value: space.space_id, label: space.title })) },
              ],
              actions: [{ label: words.invite_send, tone: 'primary', busy_label: words.invite_busy, send: { path: '/work/api/workspace/invite', with_fields: true } }],
            } : { detail: words.no_pursuits }),
          }] : []),
        ],
        note: members ? (members.length ? undefined : words.members_empty) : words.members_unreadable,
      },
    ],
  };
}
