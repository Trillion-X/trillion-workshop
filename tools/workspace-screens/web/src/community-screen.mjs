// A community's public page, /community/<id>, for someone signed out: the spaces the community opens to everyone
// (src/community.mjs), handed to the shared page renderer (packages/ui server-rendered-page), which writes every tag.
// Signed in, the same address opens the workspace with that community (src/workspace/
// community-screen.tsx), where members post, reply, vote, answer events, mark lessons done and claim rewards. A
// hand-over link (?take_over=) asks the visitor to sign in first; once signed in it opens in the workspace with the
// take-over offered there.
import { htmlPage } from './html-page.mjs';
import { signInAddress } from './workspace/addresses.mjs';

const when = iso => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }) : null);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const enc = encodeURIComponent;

export function communityPage({ origin, view, takeOver = null, here = `/community/${enc(view.community_id)}` }) {
  const signIn = { label: 'Sign in', href: signInAddress(here) };
  // A public lesson address is the same community projection with two selectors.
  // Resolve both against what this request is allowed to see; a stale or private
  // course/lesson therefore falls back to the ordinary public community page.
  const address = new URL(here, origin);
  const courseId = address.searchParams.get('course_id');
  const lessonId = address.searchParams.get('lesson_id');
  const selectedCourse = courseId && lessonId
    ? (view.courses ?? []).find(course => course.course_id === courseId)
    : null;
  const selectedLesson = selectedCourse?.lessons.find(lesson => lesson.lesson_id === lessonId) ?? null;
  const lessonAddress = (course, lesson) => {
    const next = new URL(`/community/${enc(view.community_id)}`, origin);
    next.searchParams.set('course_id', course.course_id);
    next.searchParams.set('lesson_id', lesson.lesson_id);
    return `${next.pathname}${next.search}`;
  };
  const sections = [{ emphasis: 'work', heading: view.title, body: `${view.about ?? ''} ${plural(view.members_count, 'member', 'members')}. ${view.join}`.trim(), actions: [signIn] }];
  // Opened from a hand-over link: signing in hands the community over.
  if (takeOver) sections.unshift({ emphasis: 'work', heading: `Run ${view.title}`, body: 'Sign in, and this link hands the community to you.', actions: [signIn] });
  if (view.events) sections.push({
    emphasis: 'work', heading: 'Events',
    ...(view.events.length ? {} : { body: 'Nothing on yet.' }),
    items: view.events.map(event => ({
      heading: event.title, meta: { label: `${event.going} going`, tone: 'quiet' }, body: event.about, details: [when(event.starts_at)],
      actions: [{ label: 'Add to calendar', href: `/community/events/${enc(event.event_id)}/calendar` }],
    })),
  });
  if (view.feed) sections.push({
    emphasis: 'work', heading: 'Posts',
    ...(view.feed.length ? {} : { body: 'No posts yet.' }),
    items: view.feed.map(post => ({ heading: post.by, meta: { label: [post.votes ? plural(post.votes, 'vote', 'votes') : null, when(post.at)].filter(Boolean).join(' · '), tone: 'quiet' }, body: post.body, details: post.replies.map(reply => `${reply.by}: ${reply.body}`) })),
  });
  if (selectedCourse && selectedLesson) {
    sections.push({
      emphasis: 'work', heading: selectedCourse.title, body: selectedCourse.about,
      items: [{
        heading: selectedLesson.title,
        body: selectedLesson.body,
        ...(selectedLesson.interactive || selectedLesson.module ? { details: ['Sign in to open the interactive lesson.'] } : {}),
        actions: [{ label: 'All lessons', href: `/community/${enc(view.community_id)}` }, ...(selectedLesson.interactive || selectedLesson.module ? [signIn] : [])],
      }],
    });
  } else {
    for (const course of view.courses ?? []) sections.push({
      emphasis: 'work', heading: course.title, body: course.about,
      items: course.lessons.map(lesson => ({
        heading: lesson.title,
        body: lesson.body,
        actions: [{ label: 'Open lesson', href: lessonAddress(course, lesson) }],
        ...(lesson.interactive || lesson.module ? { details: ['Sign in to open the interactive lesson.'], actions: [{ label: 'Open lesson', href: lessonAddress(course, lesson) }, signIn] } : {}),
      })),
    });
  }
  if (view.members) sections.push({
    emphasis: 'work', heading: 'Members',
    items: view.members.map(person => ({ heading: person.name, body: person.role === 'owner' ? 'Runs this community' : person.role === 'member' ? null : person.role, meta: { label: person.level ?? 'Member', tone: 'quiet' } })),
  });
  if (view.levels?.bands?.length) sections.push({
    emphasis: 'work', heading: 'Levels',
    body: view.levels.ways_to_earn.length ? `Counted in ${view.levels.measure}: ${view.levels.ways_to_earn.map(way => `${way.says ?? way.kind} ${way.adds}`).join(', ')}.` : null,
    items: view.levels.bands.map(band => ({ heading: band.name, meta: { label: `from ${band.from}`, tone: 'quiet' } })),
  });
  // The page is the community's own: its name is the title, and nothing on it sends a visitor to Trillion.
  const title = selectedCourse && selectedLesson ? `${selectedLesson.title} | ${view.title}` : view.title;
  const canonicalPath = selectedLesson ? lessonAddress(selectedCourse, selectedLesson) : `/community/${enc(view.community_id)}`;
  const description = selectedLesson ? (selectedCourse.about || selectedLesson.title) : (view.about || view.title);
  return htmlPage({ title, meta_description: description, canonical_origin: origin, canonical_path: canonicalPath, sections,
    share: { type: 'website', site_name: view.title, title, description, url: `${origin}${canonicalPath}` } });
}
