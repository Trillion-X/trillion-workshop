// src/workspace/community-screen.tsx
//
// PURPOSE
//   The places any space turns on (the space tools of records/workshop-space-tool-records.json), drawn inside that space's own screen
//   (spaces-screen.tsx hosts each one with mountCommunityPlace, beside its conversation, people and rules). A community
//   is a space like any other, so there is no separate Community screen: every place below is something a project, a
//   group or a community shows once it is turned on. Each is drawn by the shared guide (parts/ui/show/coss/guide.tsx)
//   through guide-screen.ts when it is chosen:
//   - Home: the posts as a feed with a box to write one, and beside them where the reader stands (their level, the
//     bar toward the next one, their streak and what they wrote, their place, their tribe title), their match this
//     week, what is coming up, and rewards ready to claim. Someone not in it yet sees how to join there instead.
//   - Matches: who the community paired the reader with, why (each reason from the pair's own records), what their
//     AIs suggest they talk about, Open chat (the one-to-one space, in its own tab) and Pass, with the "Pair me
//     automatically" switch and when the next round is. The owner, 2026-09-28: "Why don't you just literally connect people
//     automatically?" and "the AI can like suggest what to talk about".
//   - Tribe: the reader's chain at each group size (the sizes are the community's DATA), top first with the reader
//     lit, who they help and who helps them, the top person's title, the top people's own group, and how it works
//     behind Learn more. The owner: "it could be, like, the most gamified community platform."
//   - Discover: people who share the reader's pursuits and what they share, with Connect and Ask my AI (a job for the
//     reader's own AIs, src/queued-work.mjs). The owner: "Hey, connect with this person. Hey, start this, dude."
//   - Classroom: the courses as cards; opening one shows its lessons, each marked done or next, with Mark done.
//   A space has no calendar of its own: its meetings are on the one Calendar (shared-calendar-screen.tsx), which Home's
//   Coming up opens.
//   - Members, Leaderboard (the reader's level, how points and levels work behind Learn more, the places in a table,
//     the rewards) and About (what it is, who runs it, joining, the email digest, rewards claimed, and taking it over
//     when a hand-over link opened it), led by the community's mission when it has one.
//   - Tools: every tool added to the space, whoever made it (src/person-spaces.mjs addedTools), each with Open (its own
//     screen on the space, a row under the pursuit in the sidebar) and, for whoever started the space, Remove; and a search of the
//     whole Marketplace (GET /work/api/workshop/find, the same find an AI's find_tool_for_job makes) whose every result
//     has Add, for everyone in the space. Points, a leaderboard, a board or a classroom are tools like any other there:
//     adding one turns its part on and adds its place, removing it keeps what it held for when it is added again.
//     The maker, 2026-10-06: "It's supposed to be a tool... a tool amongst other tools."
//   A place shows as a row under its pursuit in the person's one sidebar only when it has something (`communityPlacesOf`, community-places.ts). A hand-over link
//   (/community/<id>?take_over=<code>, which opens /spaces/<id> once signed in) opens the space on About, offering to
//   take it over (space-kinds.json `turned_on_places`).
//   Reads go through /work/api/community (src/work-community.mjs) and every action posts to the same /community
//   routes the person's AI uses (src/person-community.mjs), so the screen and the AI always agree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real numbers: every level, point, place, streak and count is one the community answered (src/progression.mjs
//      over the member's own facts). A number the community does not keep is not shown.
//   2. Nothing here names a measure, a level or a kind of activity: those are the community's DATA, shown in its words.
//   3. Every control is the shared guide's (rows, the profile card, the banner and its Learn more, the ranked table,
//      course cards, the thread as a feed, boxes, confirm in place) and the places are rows of the one sidebar; this file only
//      builds the descriptions and does what each action says. There are no modals.
//   4. Choosing a place, opening a course or going back draws again from the last read; the community is read again
//      only after an action, on Try again, and when the page is shown again (guide-screen.ts).

import type { GuideAction, GuideDescription, GuideRow, GuideSection } from '../../parts/ui/show/coss/guide';
import type { ThreadPost } from '../../parts/ui/show/coss/thread';
import { notify } from '../../parts/ui/show/coss/notifications';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { postJson, readAnswer, readJson } from './api';
import { IsolatedModuleSurface } from '../../parts/ui/show/isolated-module-surface/IsolatedModuleSurface';
import { lessonPracticeLabel, moduleSurfaceRequest, moduleSurfaceRequestCanRetry, moduleSurfaceScopeKey, validateModuleSurfaceRequests } from '../../parts/ui/show/isolated-module-surface/module-surface-requests.mjs';
import { runAddressedResourceAction } from './resource-target';
import { guideScreen, LOCAL, type Act } from './guide-screen';
import { communityPlacesOf, toolPlace, type Post, type Event, type TribeMember, type Tribe, type FoundTool, type CommunityView } from './community-places';
import { goTo, openScreen } from './open-screen';
import { replaceWorkspaceAddress } from './addresses.mjs';
import { ScreenState, type EmptyScreenState } from '../../parts/ui/show/screen-state';

/** Where the reader is among the places: the chosen place, the course open in Classroom, and the last search for a
 *  tool to add (Tools). */
type Where = { place: string; course: string | null; lesson?: string | null; found?: { job: string; tools: FoundTool[] } };

const API = '/work/api/community';
const at = (id: string) => `/community/${encodeURIComponent(id)}`;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const ordinal = (place: number) => `${place}${['th', 'st', 'nd', 'rd'][(place % 100 >= 11 && place % 100 <= 13) || place % 10 > 3 ? 0 : place % 10]}`;
const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
const LESSON: Record<string, { label: string; tone: string }> = { complete: { label: 'Done', tone: 'good' }, active: { label: 'Next', tone: 'attention' } };
const ROLE: Record<string, string> = { owner: 'Runs this pursuit' };
// A match's state in the reader's words; a match that ended (passed, or nobody answered in time) is not shown.
const MATCH: Record<string, { label: string; tone: string }> = {
  proposed: { label: 'Asks you', tone: 'attention' }, one_yes: { label: 'Waiting for an answer', tone: 'info' },
  waiting_for_ais: { label: 'Finding topics', tone: 'info' }, introduced: { label: 'Introduced', tone: 'good' }, talked: { label: 'You talked', tone: 'good' },
};
const ENDED = ['passed', 'expired'];
// An introduction still waiting for answers (src/introduction-states.json): nobody shares a space until everyone says yes.
const ASKING = ['proposed', 'one_yes'];
// The job "Ask my AI" hands the reader's own AIs about someone found in Discover (a row of src/queued-work.json).
const ASK_ABOUT_MEMBER = 'connect-community-member';
// The one Calendar, where a space's meetings are (surfaces.json, tool:screen-calendar).
const CALENDAR = 'trillion.calendar';
// The space's own roads (src/work-spaces.mjs): adding and taking out a tool, for everyone in it.
const SPACES = (id: string) => `/work/api/spaces/${encodeURIComponent(id)}`;
// A tool added for everyone in the space, now and whoever joins later (src/spaces.mjs EVERY_MEMBER).
const EVERY_MEMBER = '*';


// A one-to-one space opens in its own tab, the same way Spaces opens one.
function openSpace(space: { id: string; title: string }) {
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.space', title: space.title, surfaceInput: { id: space.id } } }));
}
const current = (view: CommunityView) => (view.matching?.matches ?? []).filter(match => !ENDED.includes(match.status));
const pressKey = () => crypto.randomUUID();

const upcoming = (view: CommunityView) => (view.events ?? []).filter(event => Date.parse(event.starts_at) >= Date.now()).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
const takeOverCode = (id: string) => (location.pathname.endsWith(`/${encodeURIComponent(id)}`) ? new URLSearchParams(location.search).get('take_over') : null);

/** Builds what each place of one space's turned-on parts shows, from one read. */
function communityPlaces(view: CommunityView, act: Act, where: Where, openPlace: (place: string) => void) {
  const { you } = view;
  const id = view.community_id;
  const measure = view.levels?.measure ?? you.next_level?.measure ?? null;
  const send = (path: string, body: unknown, said: string) => async () => { await postJson(`${at(id)}${path}`, body); notify(said, { kind: 'done' }); };
  const go = (action: GuideAction, place: string, course: string | null = null, lesson: string | null = null) => act(action, async () => { where.place = place; where.course = course; where.lesson = lesson; return LOCAL; });

  const joinSection = (): GuideSection => ({
    heading: `Join ${view.title}`,
    body: you.may_join
      ? `${plural(view.members_count, 'person is', 'people are')} in it. ${view.feed ? 'Join to post, reply and vote.' : 'Join to read the posts and write your own.'}`
      : view.join,
    rows: you.may_join ? [{
      id: 'join', title: `Your name in ${view.title}`, detail: 'Members see only this name, never how to reach you.', open_label: 'Join', starts_open: true,
      fields: [{ name: 'name', label: 'Name', secret: false, placeholder: 'Your first name' }],
      actions: [act({ label: 'Join', tone: 'primary', send: { path: '', with_fields: true } }, async values => {
        await postJson(`${at(id)}/join`, { name: values.name?.trim() || undefined });
        notify(`You joined ${view.title}`, { kind: 'done' });
      })],
    } as GuideRow] : [],
  });

  const rsvp = (event: Event): GuideAction => (event.you_are_going
    ? act({ label: 'Not going', tone: 'plain' }, async () => { await postJson(`/community/events/${encodeURIComponent(event.event_id)}/rsvp`, { going: false }); notify('You are not going', { kind: 'done' }); })
    : act({ label: 'Going', tone: 'quiet' }, async () => { await postJson(`/community/events/${encodeURIComponent(event.event_id)}/rsvp`, { going: true }); notify('You are going', { kind: 'done' }); }));
  // The reader's own answer is the row's status; how many others go is said in its words.
  const eventRow = (event: Event, detail: (string | null | undefined)[], actions: GuideAction[]): GuideRow => ({
    id: event.event_id, title: event.title, detail: detail.filter(Boolean).join(' · ') || undefined,
    ...(event.you_are_going ? { status: { label: 'You are going', tone: 'good' } } : {}), actions,
  });
  const hours = (event: Event) => (event.ends_at ? `${clock(event.starts_at)} to ${clock(event.ends_at)}` : clock(event.starts_at));

  // Home: the feed, with where the reader stands beside it.
  function home(): GuideDescription {
    const sections: GuideSection[] = [];
    const aside: GuideSection[] = [];
    if (view.feed) {
      const post = (row: Post): ThreadPost => ({
        id: row.post_id, author: row.by, you: row.yours, ...(row.yours ? { tag: 'You' } : {}), when: when(row.at), body: row.body, score: row.votes, voted: row.your_votes > 0,
        ...(you.member ? {
          vote: row.your_votes > 0
            ? act({ label: 'Take my vote back' }, send(`/posts/${encodeURIComponent(row.post_id)}/vote`, { votes: -1 }, 'Vote taken back'))
            : act({ label: 'Vote for this' }, send(`/posts/${encodeURIComponent(row.post_id)}/vote`, { votes: 1 }, 'Voted')),
        } : {}),
        replies: (row.replies ?? []).map(post),
      });
      sections.push({
        thread: {
          style: 'cards',
          ...(you.member ? { compose: { placeholder: `Say something to ${view.title}`, action: act({ label: 'Post' }, async values => { await send('/posts', { body: values.text }, 'Posted')(); }) } } : {}),
          // Replies answer the post at the top of the thread, which is how the community keeps them.
          posts: view.feed.map(row => ({
            ...post(row),
            ...(you.member ? { reply: act({ label: 'Reply' }, async values => { await send('/posts', { body: values.text, reply_to: row.post_id }, 'Replied')(); }), reply_placeholder: `Reply to ${row.by}` } : {}),
          })),
          empty: you.member ? 'No posts yet. Say what you are working on.' : 'No posts yet.',
        },
      });
    }
    // Someone not in it yet: joining is the one thing to do, so it leads the page.
    if (!you.member) sections.unshift(joinSection());

    if (you.member) {
      const value = measure ? you.measures?.[measure] : undefined;
      const next = you.next_level;
      const from = view.levels?.bands.find(band => band.name === you.level?.name)?.from ?? 0;
      const facts = [
        ...(you.streak ? [{ label: capital(you.streak.label), value: String(you.streak.periods), icon: 'Flame' }] : []),
        ...(you.counts?.post ? [{ label: 'Posts', value: String(you.counts.post), icon: 'MessageSquare' }] : []),
        ...(you.counts?.reply ? [{ label: 'Replies', value: String(you.counts.reply), icon: 'Reply' }] : []),
        ...(view.tribe?.you.status ? [{ label: 'Tribe', value: view.tribe.you.status, icon: 'Crown' }] : []),
      ];
      aside.push({
        profile: {
          name: you.name ?? 'You',
          mark: {},
          ...(you.owner ? { tag: 'Owner' } : you.role && you.role !== 'member' ? { tag: capital(you.role) } : {}),
          ...(you.level ? { detail: `Level ${you.level.number} of ${you.level.of}` } : {}),
          ...(measure && value !== undefined ? {
            meter: {
              label: you.level?.name ?? capital(measure),
              progress: next ? (value - from) / Math.max(1, value + next.needs - from) : 1,
              // "1 / 5 points": the count against the next level reads right at any number, where "1 points" did not.
              start: next ? `${value} / ${value + next.needs} ${measure}` : `${value} ${measure}`,
              end: next ? `${next.needs} more to ${next.name}` : 'The top level',
            },
          } : {}),
          ...(facts.length ? { facts } : {}),
          ...(you.place && measure ? { highlight: { title: 'Your place', detail: `By ${measure}`, value: `#${you.place.place} of ${you.place.of}`, icon: 'Trophy' } } : {}),
          ...(view.leaderboard?.places.length ? { action: go({ label: 'See the leaderboard', tone: 'plain' }, 'leaderboard') } : {}),
        },
      });
    }

    const matched = current(view);
    if (matched.length) aside.push({
      heading: matched.length === 1 ? 'Your match' : 'Your matches',
      rows: matched.map(match => ({
        id: `match:${match.match_id}`, title: match.with.name,
        detail: match.why[0] ?? match.with.level ?? undefined,
        ...(MATCH[match.status] ? { status: MATCH[match.status] } : {}),
      })),
      actions: [go({ label: matched.length === 1 ? 'See your match' : 'See your matches', tone: 'plain' }, 'matches')],
    });

    const soon = upcoming(view).slice(0, 3);
    if (soon.length) aside.push({
      heading: 'Coming up',
      rows: soon.map(event => eventRow(event, [`${day(event.starts_at)}, ${hours(event)}`, event.going ? `${event.going} going` : null], you.member ? [rsvp(event)] : [])),
      actions: [act({ label: 'See the calendar', tone: 'plain' }, async () => { openScreen(CALENDAR); return LOCAL; })],
    });
    const ready = (you.rewards ?? []).filter(reward => reward.can_claim);
    if (ready.length) aside.push({
      heading: 'Ready to claim',
      rows: ready.map(reward => ({
        id: reward.id, title: reward.title, detail: reward.says ?? undefined, status: { label: 'Ready', tone: 'attention' },
        actions: [act({ label: 'Claim', tone: 'primary' }, send(`/rewards/${encodeURIComponent(reward.id)}/claim`, {}, `${reward.title} claimed`))],
      })),
    });
    return { title: view.title, hide_header: true, sections, aside };
  }

  // Matches: who the reader was paired with, why, what to talk about, and the switch that keeps it going.
  function matches(): GuideDescription {
    const matching = view.matching!;
    const shown = current(view);
    const next = matching.next_at ? `The next round is ${when(matching.next_at)}.` : null;
    const sections: GuideSection[] = [{
      heading: 'Matches',
      body: 'Trillion pairs you with someone who can help with what you are working on, and someone you can help. Your AIs suggest what to talk about.',
      actions: [act({ label: 'Pair me automatically', switch: { on: matching.on } }, send('/matching', { on: !matching.on }, matching.on ? 'You will not be paired' : 'You will be paired automatically'))],
      note: [matching.cadence_label, matching.on ? next : null].filter(Boolean).join('. '),
    }];
    if (shown.length) sections.push({
      heading: shown.length === 1 ? 'Your match' : 'Your matches',
      people: shown.map(match => ({
        id: match.match_id, name: match.with.name,
        ...(match.with.level ? { tag: match.with.level } : {}),
        ...(MATCH[match.status] ? { status: MATCH[match.status] } : {}),
        lists: [
          ...(match.why.length ? [{ label: 'Why you two', items: match.why }] : []),
          ...(ASKING.includes(match.status)
            ? [{ label: 'Where it stands', items: [match.answered === 'yes' ? `You said yes. ${match.says}` : `${match.says}${match.answer_by ? ` Answer by ${when(match.answer_by)}.` : ''}`] }]
            : [{ label: 'Talk about', items: match.topics, style: 'chips' as const, empty: 'Your AIs are finding things for you two to talk about.' }]),
        ],
        actions: [
          ...(match.space_id ? [act({ label: 'Open chat', tone: 'primary', icon: 'MessageCircle' }, async () => { openSpace({ id: match.space_id!, title: `You and ${match.with.name}` }); return LOCAL; })] : []),
          ...(ASKING.includes(match.status) && match.answered !== 'yes'
            ? [act({ label: `Meet ${match.with.name}`, tone: 'primary' }, send(`/matches/${encodeURIComponent(match.match_id)}/answer`, { yes: true, consent: match.consent }, `You said yes to meeting ${match.with.name}`))]
            : []),
          act({ label: 'Pass', tone: 'plain', send: { path: '', confirm: `Pass on ${match.with.name}? You will be paired with someone else next round.` } }, send(`/matches/${encodeURIComponent(match.match_id)}/answer`, { yes: false }, `Passed on ${match.with.name}`)),
        ],
      })),
    });
    else sections.push({
      empty: matching.on
        ? { icon: 'Handshake', title: 'No match yet', body: next ?? 'You will be paired in the next round.' }
        : { icon: 'Handshake', title: 'Pairing is off', body: 'Turn on Pair me automatically and Trillion finds you someone each round.' },
    });
    return { title: 'Matches', hide_header: true, sections };
  }

  // Tribe: the reader's chain at each group size, top first, who they help and who helps them, and the top group.
  function tribe(): GuideDescription {
    const chain = view.tribe!;
    const title = chain.status_name;
    const link = (member: TribeMember) => ({
      id: `${member.place}:${member.name}`, name: member.name, highlight: member.you,
      ...(member.you ? { detail: 'You' } : {}),
      ...(member.level ? { tag: member.level } : {}),
      ...(member.status ? { badge: { label: member.status, icon: 'Crown' } } : {}),
    });
    const lines = [
      chain.you.helps ? `You help ${chain.you.helps.name}.` : null,
      chain.you.helped_by ? `${chain.you.helped_by.name} helps you.` : null,
    ].filter(Boolean).join(' ');
    const sections: GuideSection[] = [{
      heading: 'Tribe',
      banner: {
        icon: 'Crown',
        title: chain.you.status ?? (lines || 'You are in the chain'),
        ...(chain.you.status && lines ? { detail: lines } : {}),
      },
      explain: {
        label: 'How tribes work', title: 'How tribes work',
        lead: 'Everyone is in a group at each size. Inside a group, people stand in a line from most to least experienced, and each person helps the one just below them.',
        steps: [
          { title: 'Help the next person', body: 'You help the person just below you, and the person just above you helps you.' },
          { title: `The top person is the ${title}`, body: `The person at the top of each group is its ${title}.` },
          { title: `The ${title}s group together`, body: `Every group's ${title} joins one more group, so they can help each other too.` },
        ],
        ladder: { label: 'Group sizes', rungs: chain.sizes.map(size => ({ name: `Group of ${size}`, current: chain.groups.some(group => group.size === size) })) },
      },
    }];
    for (const group of chain.groups) sections.push({
      heading: group.label,
      chain: { label: group.label, between: 'helps', links: group.members.map(link) },
    });
    if (chain.top_group?.members.length) sections.push({
      heading: chain.top_group.label,
      body: `The ${title} of every group, together.`,
      chain: { label: chain.top_group.label, links: chain.top_group.members.map(link) },
    });
    return { title: 'Tribe', hide_header: true, sections };
  }

  // Discover: people who share the reader's pursuits, with Connect and Ask my AI.
  function discover(): GuideDescription {
    return {
      title: 'Discover', hide_header: true,
      sections: [{
        heading: 'People working on what you are',
        body: 'They share what you are working toward. Connect, or ask your AI to work out what you could do together.',
        people: (view.discover ?? []).map((person, index) => ({
          id: `discover:${person.relay ?? index}`, name: person.name,
          ...(person.level ? { tag: person.level } : {}),
          lists: [
            ...(person.shared.length ? [{ label: 'You both', items: person.shared, style: 'chips' as const }] : []),
            ...(person.offers.length ? [{ label: 'Can help with', items: person.offers }] : []),
            ...(person.seeks.length ? [{ label: 'Looking for', items: person.seeks }] : []),
          ],
          actions: [
            ...(person.connect && person.relay ? [act({ label: 'Connect', tone: 'primary', icon: 'UserPlus' }, send('/connect', { to: person.relay }, `Asked to connect with ${person.name}`))] : []),
            act({ label: 'Ask my AI', tone: 'quiet', icon: 'Sparkles' }, async () => {
              const answer = await postJson<{ said?: string }>('/work/api/queue', { job_id: ASK_ABOUT_MEMBER, context: { name: person.name, community_id: id }, press_key: pressKey() });
              notify(answer.said ?? 'Sent to your AI', { kind: 'done' });
            }),
          ],
        })),
      }],
    };
  }

  // Classroom: the courses as cards, or the open course's lessons.
  function classroom(): GuideDescription {
    const courses = view.courses ?? [];
    const open = courses.find(course => course.course_id === where.course);
    const activeLesson = open?.lessons.find(lesson => lesson.lesson_id === where.lesson);
    if (open && activeLesson) return {
      title: activeLesson.title, hide_header: true,
      sections: [
        { actions: [go({ label: 'All lessons', tone: 'plain', icon: 'ArrowLeft' }, 'classroom', open.course_id)] },
        ...(activeLesson.body ? [{ heading: activeLesson.title, body: activeLesson.body }] : []),
        ...(activeLesson.module ? [{ part: 'saved-lesson-module' }] : []),
        {
          heading: 'Lesson progress',
          rows: [{ id: `${open.course_id}/${activeLesson.lesson_id}/progress`, title: LESSON[activeLesson.status]?.label ?? 'Lesson',
            ...(you.member && activeLesson.status !== 'complete' ? { actions: [act({ label: 'Mark done', tone: 'quiet' }, send('/lessons', { course_id: open.course_id, lesson_id: activeLesson.lesson_id, done: true }, 'Lesson done'))] } : {}) }],
        },
      ],
    };
    if (open) return {
      title: open.title, hide_header: true,
      sections: [
        { actions: [go({ label: 'All courses', tone: 'plain', icon: 'ArrowLeft' }, 'classroom')] },
        {
          heading: open.title,
          body: [open.about, you.member ? `${open.done} of ${plural(open.of, 'lesson', 'lessons')} done.` : null].filter(Boolean).join(' '),
          rows: open.lessons.map(lesson => ({
            id: `${open.course_id}/${lesson.lesson_id}`,
            title: lesson.title,
            detail: lesson.body ?? undefined,
            status: LESSON[lesson.status] ?? { label: 'Later', tone: 'quiet' },
            actions: [
              go({ label: 'Open lesson', tone: 'primary', icon: lesson.module ? 'Play' : 'ArrowRight' }, 'classroom', open.course_id, lesson.lesson_id),
              ...(you.member && lesson.status !== 'complete' ? [act({ label: 'Mark done', tone: 'quiet' }, send('/lessons', { course_id: open.course_id, lesson_id: lesson.lesson_id, done: true }, 'Lesson done'))] : []),
            ],
          })),
        },
      ],
    };
    return {
      title: 'Classroom', hide_header: true,
      sections: [{
        heading: 'Classroom',
        courses: courses.map(course => ({
          id: course.course_id, title: course.title, ...(course.about ? { about: course.about } : {}), icon: 'GraduationCap',
          ...(you.member ? { done: course.done, of: course.of, progress_label: `${course.done} of ${plural(course.of, 'lesson', 'lessons')} done` } : { progress_label: plural(course.of, 'lesson', 'lessons') }),
          ...(you.member && course.of && course.done === course.of ? { status: { label: 'Done', tone: 'good' } } : {}),
          action: go({ label: !you.member ? 'Open' : course.done ? 'Continue' : 'Start', tone: 'primary' }, 'classroom', course.course_id),
        })),
      }],
    };
  }

  function members(): GuideDescription {
    return {
      title: 'Members', hide_header: true,
      sections: [{
        heading: plural(view.members_count, 'member', 'members'),
        ranks: (view.members ?? []).map((person, index) => ({
          id: `member:${index}`, name: person.name, highlight: person.you,
          detail: [person.you ? 'You' : null, ROLE[person.role] ?? (person.role === 'member' ? null : capital(person.role))].filter(Boolean).join(' · ') || undefined,
          ...(person.level ? { tag: person.level } : {}),
        })),
      }],
    };
  }

  // Leaderboard: the reader's level, how it works behind Learn more, the places, and the rewards.
  function leaderboard(): GuideDescription {
    const board = view.leaderboard!;
    const counted = view.levels?.measure ?? board.measure;
    const sections: GuideSection[] = [{
      heading: 'Leaderboard',
      ...(you.member && you.level ? {
        banner: {
          icon: 'Trophy', title: `Your level: ${you.level.name}`,
          ...(you.place ? { value: ordinal(you.place.place), detail: `of ${plural(you.place.of, 'member', 'members')}, by ${counted}` } : {}),
        },
      } : {}),
      ...(view.levels?.bands.length ? {
        explain: {
          label: `How ${counted} work`, title: 'How levels work',
          lead: `Levels count ${counted}. Each of these adds to them.`,
          steps: view.levels.ways_to_earn.map(way => ({ title: `+${way.adds}`, body: capital(way.says ?? way.kind ?? '') })),
          ladder: { label: 'Levels', rungs: view.levels.bands.map(band => ({ name: band.name, detail: `from ${band.from} ${counted}`, current: you.level?.name === band.name })) },
        },
      } : {}),
      table: {
        name_label: 'Member',
        columns: [{ id: 'value', label: capital(board.measure), align: 'end', accent: true }],
        rows: board.places.map(row => ({
          id: `place:${row.place}:${row.name}`, place: row.place, name: row.name, highlight: row.you, ...(row.you ? { tag: 'You' } : {}),
          ...(row.level ? { detail: row.level } : {}), cells: { value: String(row.value) },
        })),
      },
    }];
    const rewards = you.rewards ?? [];
    if (rewards.length) sections.push({
      heading: 'Rewards',
      rows: rewards.map(reward => ({
        id: reward.id, title: reward.title, detail: reward.says ?? undefined,
        status: reward.claimed ? { label: 'Claimed', tone: 'good' } : reward.can_claim ? { label: 'Ready', tone: 'attention' } : { label: `${reward.have} of ${reward.needs.at_least} ${reward.needs.measure}`, tone: 'quiet' },
        ...(reward.can_claim ? { actions: [act({ label: 'Claim', tone: 'primary' }, send(`/rewards/${encodeURIComponent(reward.id)}/claim`, {}, `${reward.title} claimed`))] } : {}),
      })),
    });
    return { title: 'Leaderboard', hide_header: true, sections };
  }

  // About: what it is, who runs it, joining, the email digest, rewards claimed, and taking it over.
  function about(): GuideDescription {
    const sections: GuideSection[] = [];
    const takeOver = takeOverCode(id);
    if (takeOver && !you.owner) sections.push({
      heading: `Run ${view.title}`,
      body: 'This link hands this pursuit to you. Members, posts and events stay as they are.',
      actions: [act({ label: 'Take it over', tone: 'primary' }, async () => {
        await postJson(`${at(id)}/take-over`, { code: takeOver });
        replaceWorkspaceAddress(null, location.pathname);
        notify(`You run ${view.title} now`, { kind: 'done' });
      })],
    });
    const runs = view.members?.find(person => person.role === 'owner')?.name;
    if (view.mission) sections.push({ banner: { icon: 'Target', title: view.mission } });
    sections.push({
      heading: `About ${view.title}`,
      ...(view.about ? { body: view.about } : {}),
      note: [plural(view.members_count, 'member', 'members'), runs ? `Run by ${runs}` : null].filter(Boolean).join(' · '),
    });
    if (!you.member) sections.push(joinSection());
    if (you.member && view.digest_offered) sections.push({
      heading: 'Email',
      rows: [you.email_digest
        ? { id: 'digest', title: 'You get an email when there is something new', status: { label: 'On', tone: 'good' }, actions: [act({ label: 'Stop the emails', tone: 'quiet' }, send('/notifications', { email_digest: false }, 'Emails stopped'))] }
        : {
          id: 'digest', title: 'Get an email when there is something new', detail: 'At most once a week, and only when something happened.', open_label: 'Email me',
          fields: [{ name: 'email', label: 'Your email', secret: false, placeholder: 'you@example.com' }],
          actions: [act({ label: 'Email me', tone: 'primary', send: { path: '', with_fields: true } }, async values => {
            await send('/notifications', { email_digest: true, email: values.email?.trim() || undefined }, 'You will get an email when something is new')();
          })],
        } as GuideRow],
    });
    if (view.claims?.length) sections.push({
      heading: 'Rewards claimed',
      rows: view.claims.map(claim => ({ id: claim.claim_id, title: claim.by, detail: `${claim.reward_id} · ${when(claim.at)}` })),
    });
    return { title: `About ${view.title}`, hide_header: true, sections };
  }

  // Tools: what is added here, and any tool in the Marketplace to add, for everyone in the space.
  function tools(): GuideDescription {
    const added = view.tools ?? [];
    const here = new Set(added.map(tool => tool.tool_id));
    const sections: GuideSection[] = [];
    if (added.length) sections.push({
      heading: 'In this pursuit',
      rows: added.map(tool => ({
        id: `tool:${tool.tool_id}`, title: tool.label, ...(tool.about ? { detail: tool.about } : {}),
        actions: [
          ...(tool.part || !tool.you_may_use ? [] : [act({ label: 'Open', tone: 'primary' }, async () => { openPlace(toolPlace(tool.tool_id)); return LOCAL; })]),
          ...(view.may_add_tools ? [act({ label: 'Remove', tone: 'quiet', send: { path: '', confirm: `Take ${tool.label} out of ${view.title} for everyone? What it holds is kept if it is added again.` } }, async () => {
            await postJson(`${SPACES(id)}/tools/remove`, { tool_id: tool.tool_id });
            notify(`${tool.label} is out of ${view.title}`, { kind: 'done' });
          })] : []),
        ],
      })),
    });
    if (!view.may_add_tools) {
      sections.push({ heading: added.length ? 'Add a tool' : 'Tools', body: added.length ? 'Whoever started this pursuit adds tools here.' : 'No tools are here yet. Whoever started this pursuit adds them.' });
      return { title: 'Tools', hide_header: true, sections };
    }
    const found = where.found;
    sections.push({
      heading: 'Add a tool',
      body: 'Any tool in the Marketplace, whoever made it. It is added for everyone here.',
      rows: [{
        id: 'find', title: 'Find a tool', open_label: 'Find', starts_open: true,
        fields: [{ name: 'job', label: 'What should it do?', secret: false, placeholder: found?.job ?? 'Rank people by how much they post' }],
        actions: [act({ label: 'Find', tone: 'primary', send: { path: '', with_fields: true } }, async values => {
          const job = values.job?.trim() ?? '';
          if (!job) return LOCAL;
          const answer = await readAnswer<{ candidates: FoundTool[] }>(`/work/api/workshop/find?job=${encodeURIComponent(job)}`);
          if (!answer.ok) throw new Error('The Marketplace could not be searched just now. Try again in a moment.');
          where.found = { job, tools: answer.value.candidates };
          return LOCAL;
        })],
        ...(found?.tools.length ? {
          items: found.tools.map(tool => ({
            id: `found:${tool.tool_id}`, title: tool.label, ...(tool.description ?? tool.job ? { detail: (tool.description ?? tool.job)! } : {}),
            ...(here.has(tool.tool_id) ? { status: { label: 'Added', tone: 'good' as const } } : {
              actions: [act({ label: 'Add', tone: 'quiet', icon: 'Plus' }, async () => {
                await postJson(`${SPACES(id)}/tools/grant`, { tool_id: tool.tool_id, member_id: EVERY_MEMBER });
                notify(`${tool.label} is in ${view.title}`, { kind: 'done' });
              })],
            }),
          })),
        } : {}),
      } as GuideRow],
    });
    if (found && !found.tools.length) sections.push({ body: `No tool was found for "${found.job}". Try other words.` });
    return { title: 'Tools', hide_header: true, sections };
  }

  const draw: Record<string, () => GuideDescription> = { home, matches, tribe, discover, classroom, members, leaderboard, about, tools };
  if (!communityPlacesOf(view).some(place => place.id === where.place)) where.place = 'home';
  return draw[where.place]();
}

/** A refusal in plain words: a space that is not there is its own empty state with the way to Spaces, and anything
 *  else is the shared failed state with Try again (thrown to the screen-state part). A plan that does not include it
 *  is the shared plan state every screen draws (failure.ts). The Worker's own words (which may carry an address) are
 *  never shown as the screen. */
function refused(answer: { status: number }): EmptyScreenState {
  if (answer.status === 400 || answer.status === 404) return {
    status: 'empty', icon: 'SearchX', title: 'This pursuit is not here any more',
    description: 'It may have been closed, or the link was mistyped. Your other pursuits are all still there.',
    action: goTo('Open pursuits', 'trillion.pursuits'),
  };
  throw Object.assign(new Error('This could not be opened just now. Nothing was lost.'), { status: answer.status });
}

/** One place of one space's turned-on parts, drawn by the guide into `element`. Every read is reported (`onView`), so
 *  the space knows which places have something; a press that goes to another place (See the leaderboard) asks the
 *  space to show that place (`onPlace`). Answers the unmount. */
export function mountCommunityPlace(element: HTMLElement, { id, place, lesson: requestedLesson, onView, onPlace }: { id: string; place: string; lesson?: { course_id: string; lesson_id: string }; onView: (view: CommunityView) => void; onPlace: (place: string) => void }): () => void {
  const where: Where = { place, course: requestedLesson?.course_id ?? null, lesson: requestedLesson?.lesson_id ?? null };
  let view: CommunityView | null = null;
  let activeLesson: import('./community-places').Course['lessons'][number] | null = null;
  let routeChecked = !requestedLesson;
  const screen = guideScreen(element, 'Loading', async (act, { fresh }) => {
    if (fresh || !view) {
      const answer = await readAnswer<CommunityView>(`${API}/${encodeURIComponent(id)}`);
      if (!answer.ok) return refused(answer);
      view = answer.value;
      onView(view);
    }
    if (!routeChecked && requestedLesson) {
      routeChecked = true;
      const permitted = view.courses?.find(course => course.course_id === requestedLesson.course_id)
        ?.lessons.some(item => item.lesson_id === requestedLesson.lesson_id) === true;
      if (!permitted) { where.course = null; where.lesson = null; }
    }
    const lesson = view.courses?.find(course => course.course_id === where.course)?.lessons.find(item => item.lesson_id === where.lesson) ?? null;
    activeLesson = lesson;
    const description = communityPlaces(view, act, where, onPlace);
    if (where.place !== place) onPlace(where.place);
    return description;
  }, { parts: { 'saved-lesson-module': SavedLessonModule } });
  function SavedLessonModule() {
    const lesson = activeLesson;
    const spec = lesson?.module;
    if (!spec || !lesson) return null;
    const surfaceInput: Record<string, unknown> = { space_id: id, community_id: id, course_id: where.course, lesson_id: lesson.lesson_id };
    try { surfaceInput.practice_record_label = lessonPracticeLabel(id, where.course, lesson.lesson_id); } catch { /* Other module capabilities remain available without this optional record binding. */ }
    const requests = spec.requests ?? {};
    try { validateModuleSurfaceRequests(requests); } catch { return <ScreenState state={{ status: 'unavailable', title: 'This interactive lesson is unavailable.', inline: true }} />; }
    return <IsolatedModuleSurface
      key={`${moduleSurfaceScopeKey(surfaceInput)}:${spec.bundle}:${spec.file}:${lesson.lesson_id}`}
      bundle={spec.bundle}
      file={spec.file}
      title={lesson.title}
      surfaceInput={surfaceInput}
      requests={requests}
      onCall={async (name, input = {}) => {
        const request = moduleSurfaceRequest(requests, name, input, surfaceInput);
        if (typeof (requests[name] as { resource_operation?: unknown })?.resource_operation === 'string') {
          return runAddressedResourceAction({ input: JSON.parse(String(request.init?.body ?? '{}')) });
        }
        return readJson(request.path, request.init, moduleSurfaceRequestCanRetry(requests[name]), { applyFocus: false });
      }}
      onMediaLease={async (identity) => readJson('/work/api/namespace/leases', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'read', identity, seconds: 3600 }),
      }, false, { applyFocus: false })}
    />;
  }
  return () => screen.unmount();
}
