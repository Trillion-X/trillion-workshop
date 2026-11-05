"""Tests of sort-youtube-watch-later-into-playlists on made-up channels, videos and recorded YouTube replies."""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(TOOL, 'do-work'))
sys.path.insert(0, os.path.join(TOOL, 'read-data'))

import youtube_client as yt  # noqa: E402
import sort_plan  # noqa: E402
import apply_sort  # noqa: E402
import verify_sort  # noqa: E402
import read_channel  # noqa: E402
import list_signed_in_accounts  # noqa: E402

import time  # noqa: E402
time.sleep = lambda s: None  # the client's waits between pages and retries


def video(vid, title, channel, views):
    return {'position': 1, 'id': vid, 'url': f'https://www.youtube.com/watch?v={vid}', 'title': title, 'channel': channel, 'views': views}


RULES = {
    'max_per_video': 2,
    'hold_back': '(Private Matter)',
    'hold_back_reason': 'kept off public playlists',
    'rules': [
        {'key': 'bread', 'title': 'Bread Baking', 'description': 'Loaves.', 'channels': '^(Crumb Club|Loaf.*)', 'strong': '(sourdough|baguette)', 'weak': '(flour)'},
        {'key': 'garden', 'title': 'Gardening', 'description': 'Plants.', 'strong': '(tomato|compost)', 'weak': '(soil|seed)'},
    ],
}
ITEMS = [
    video('v1', 'Easy sourdough in a day', 'Crumb Club', '1.2M views'),
    video('v2', 'My sourdough starter', 'Someone', '3K views'),
    video('v3', 'Garden compost and sourdough discard', 'Someone', '500 views'),
    video('v4', 'Which flour', 'Someone', '10 views'),
    video('v5', 'A Private Matter', 'Crumb Club', '9 views'),
    video('v6', 'Nothing to see', 'Someone', '1 view'),
    video('v7', 'Seed swap', 'Loaf Lovers', '2,000 views'),
]


class PlanTests(unittest.TestCase):
    def test_rules_scores_hold_back_and_order(self):
        _items, pls, unsorted, held = sort_plan.classify_rules(RULES, ITEMS)
        bread = [(i['id'], i['confidence']) for i in sorted(pls['bread']['items'], key=lambda i: -i['_v'])]
        self.assertEqual(bread, [('v1', 'high'), ('v2', 'medium'), ('v7', 'medium'), ('v3', 'medium'), ('v4', 'low')])
        self.assertEqual([(i['id'], i['confidence']) for i in pls['garden']['items']], [('v3', 'medium')])
        self.assertEqual([u['id'] for u in unsorted], ['v6'])
        self.assertEqual(held, [{'id': 'v5', 'title': 'A Private Matter', 'reason': 'kept off public playlists'}])
        self.assertIn('channel Crumb Club', pls['bread']['items'][0]['reason'])

    def test_weak_only_match_goes_to_its_best_low(self):
        _i, pls, _u, _h = sort_plan.classify_rules(RULES, ITEMS)
        flour = [i for p in pls.values() for i in p['items'] if i['id'] == 'v4']
        self.assertEqual([(i['confidence'], i['reason']) for i in flour], [('low', 'weak title "flour"')])

    def test_max_per_video(self):
        cfg = dict(RULES, max_per_video=1)
        _i, pls, _u, _h = sort_plan.classify_rules(cfg, ITEMS)
        self.assertEqual([i['id'] for i in pls['garden']['items']], [])
        self.assertIn('v3', [i['id'] for i in pls['bread']['items']])

    def test_plan_sorts_by_views_and_drops_empty(self):
        a = sort_plan.make_plan({'channels': [{'slug': 's', 'label': 'S', 'sort': 'rules', 'rules': RULES, 'sign_in_as': '@s'}]}, {'s': ITEMS})[0]['accounts'][0]
        self.assertEqual([p['key'] for p in a['playlists']], ['bread', 'garden'])
        self.assertEqual([i['id'] for i in a['playlists'][0]['items']], ['v1', 'v2', 'v7', 'v3', 'v4'])
        self.assertNotIn('_v', a['playlists'][0]['items'][0])
        self.assertEqual(a['sign_in_as'], '@s')

    def test_hand_made_keeps_order_and_refuses_missing(self):
        lists = [{'key': 'k', 'title': 'Picked', 'description': 'd', 'videos': [['v7', 'second'], ['v1', 'first']]}]
        a = sort_plan.make_plan({'channels': [{'slug': 'h', 'label': 'H', 'sort': 'hand-made', 'playlists': lists}]}, {'h': ITEMS})[0]['accounts'][0]
        self.assertEqual([i['id'] for i in a['playlists'][0]['items']], ['v7', 'v1'])
        self.assertEqual(len(a['unsorted']), 5)
        with self.assertRaises(sort_plan.SettingsError):
            sort_plan.make_plan({'channels': [{'slug': 'h', 'label': 'H', 'sort': 'hand-made', 'playlists': [{'key': 'k', 'title': 't', 'description': 'd', 'videos': [['gone', 'x']]}]}]}, {'h': ITEMS})
        with self.assertRaises(sort_plan.SettingsError):
            sort_plan.make_plan({'channels': [{'slug': 'h', 'label': 'H', 'sort': 'by-colour'}]}, {'h': ITEMS})

    def test_markdown_names_counts_and_low(self):
        plan, lines = sort_plan.make_plan({'channels': [{'slug': 's', 'label': 'S', 'email': 'e', 'sort': 'rules', 'rules': RULES}, {'slug': 'r', 'label': 'R'}]}, {'s': ITEMS}, 'now')
        md = '\n'.join(lines)
        self.assertEqual(plan['generated'], 'now')
        self.assertIn('## S (e) : Watch Later 7; sorted into playlists 5; unsorted 1; held back 1', md)
        self.assertIn('**LOW** [Which flour]', md)
        self.assertIn('### Held back', md)
        self.assertEqual([a['slug'] for a in plan['accounts']], ['s'])


def run_cmd(name, req):
    r = subprocess.run([sys.executable, os.path.join(TOOL, 'do-work', name)], input=json.dumps(req), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])


class PlanCommandTests(unittest.TestCase):
    def test_refuses_without_settings(self):
        code, out = run_cmd('plan_sort.py', {})
        self.assertEqual(code, 2)
        self.assertIn('settings', out['error'])

    def test_inline_and_files(self):
        settings = {'channels': [{'slug': 's', 'label': 'S', 'sort': 'rules', 'rules': RULES}]}
        code, out = run_cmd('plan_sort.py', {'settings': settings, 'watch_later': {'s': ITEMS}, 'generated': 'g'})
        self.assertEqual(code, 0)
        self.assertEqual(out['result']['plan']['generated'], 'g')
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, 'acc', 's'))
            json.dump({'items': ITEMS}, open(os.path.join(d, 'acc', 's', 'watch-later.json'), 'w'))
            code, out = run_cmd('plan_sort.py', {'settings': settings, 'accounts_dir': os.path.join(d, 'acc'), 'out_dir': os.path.join(d, 'out')})
            self.assertEqual(code, 0, out)
            self.assertTrue(os.path.exists(os.path.join(d, 'out', 'SORT-PLAN.md')))
            self.assertEqual(json.load(open(out['result']['plan_file']))['accounts'][0]['watch_later_count'], 7)

    def test_settings_record_from_the_persons_list(self):
        settings = {'channels': [{'slug': 's', 'label': 'S', 'sort': 'rules', 'rules': RULES}]}
        record = {'id': 'record:setting:sort-youtube-watch-later-into-playlists~person~sam', 'type': 'record:setting',
                  'value': {'name': 'sort', 'tool': 'tool:plan-sorting-youtube-watch-later-into-playlists', 'scope_kind': 'person', 'scope_id': 'sam',
                            'settings': json.dumps(settings), 'from': 'old/rules.json@abc', 'status': 'active'}}
        code, out = run_cmd('plan_sort.py', {'settings_record': record, 'watch_later': {'s': ITEMS}, 'generated': 'g'})
        self.assertEqual(code, 0, out)
        inline = run_cmd('plan_sort.py', {'settings': settings, 'watch_later': {'s': ITEMS}, 'generated': 'g'})[1]
        self.assertEqual(out['result']['plan'], inline['result']['plan'])
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'record.json')
            json.dump(record, open(path, 'w'))
            code, out = run_cmd('plan_sort.py', {'settings_record': path, 'watch_later': {'s': ITEMS}, 'generated': 'g'})
            self.assertEqual(code, 0, out)
        other = dict(record, id='record:setting:another-tool~person~sam')
        code, out = run_cmd('plan_sort.py', {'settings_record': other, 'watch_later': {'s': ITEMS}})
        self.assertEqual(code, 2)
        self.assertIn('sort-youtube-watch-later-into-playlists', out['error'])
        wrong_tool = dict(record, value=dict(record['value'], tool='tool:something-else'))
        code, out = run_cmd('plan_sort.py', {'settings_record': wrong_tool, 'watch_later': {'s': ITEMS}})
        self.assertEqual(code, 2)
        self.assertIn('tool:something-else', out['error'])
        two = [dict(record, id='record:setting:sort-youtube-watch-later-into-playlists~person~kim', value=dict(record['value'], scope_id='kim', settings='{"channels": [{"slug": "k", "label": "K"}]}')), record]
        code, out = run_cmd('plan_sort.py', {'settings_record': two, 'person': 'sam', 'watch_later': {'s': ITEMS}, 'generated': 'g'})
        self.assertEqual(out['result']['plan'], inline['result']['plan'])
        retired = dict(record, value=dict(record['value'], status='retired'))
        code, out = run_cmd('plan_sort.py', {'settings_record': retired, 'watch_later': {'s': ITEMS}})
        self.assertEqual(code, 2)
        self.assertIn('retired', out['error'])
        empty = dict(record, value=dict(record['value'], settings='{"channels": []}'))
        code, out = run_cmd('plan_sort.py', {'settings_record': empty, 'watch_later': {}})
        self.assertEqual(code, 2)
        self.assertIn('no channels', out['error'])

    def test_missing_watch_later_says_read_first(self):
        code, out = run_cmd('plan_sort.py', {'settings': {'channels': [{'slug': 's', 'label': 'S', 'sort': 'rules', 'rules': RULES}]}})
        self.assertEqual(code, 2)
        self.assertIn('read_channel.py', out['error'])


COOKIES = '\n'.join([
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tyt-value',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tyt-sid',
    '.google.com\tTRUE\t/\tTRUE\t0\tSID\tgoogle-sid',
    '.example.com\tTRUE\t/\tTRUE\t0\tOTHER\tx',
]) + '\n'


class FakeYouTube:
    """Recorded replies by endpoint: a page per account number, playlists by id, and what was written."""

    def __init__(self, accounts, playlists=None, signed_in=True):
        self.accounts = accounts
        self.playlists = playlists or {}
        self.signed_in = signed_in
        self.writes = []

    def page(self, authuser):
        return ('<script>ytcfg.set({"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_VERSION":"2.1","VISITOR_DATA":"vd","LOGGED_IN":%s})</script>' % ('true' if self.signed_in else 'false')).encode()

    def browse(self, body):
        bid = body.get('browseId') or ''
        cont = body.get('continuation')
        if cont:
            pid, _, page = cont.partition(':')
            return self.playlist_page(pid, int(page))
        if bid.startswith('VL'):
            return self.playlist_page(bid[2:], 0)
        if bid == 'FEplaylist_aggregation':
            return {'contents': [{'lockupViewModel': {'contentId': pid, 'contentType': 'LOCKUP_CONTENT_TYPE_PLAYLIST', 'metadata': {'title': {'content': p['title']}}}} for pid, p in self.playlists.items() if pid != 'WL']}
        if bid == 'FEchannels':
            return {'contents': [{'channelRenderer': {'channelId': 'UC1', 'title': {'simpleText': 'Crumb Club'}}}]}
        raise AssertionError(bid)

    def playlist_page(self, pid, page):
        vids = self.playlists.get(pid, {'items': []})['items']
        chunk = vids[page * 2:page * 2 + 2]
        out = {'contents': [{'playlistVideoRenderer': {'videoId': v, 'title': {'runs': [{'text': 'T ' + v}]}, 'shortBylineText': {'simpleText': 'C'}, 'lengthSeconds': '61', 'lengthText': {'simpleText': '1:01'}}} for v in chunk]}
        if page * 2 + 2 < len(vids):
            out['contents'].append({'continuationItemRenderer': {'continuationEndpoint': {'continuationCommand': {'token': f'{pid}:{page + 1}'}}}})
        return out

    def urlopen(self, req, timeout=None):
        url = req.full_url
        if '/youtubei/v1/' not in url:
            if 'playlist?list=' in url:
                pid = url.split('list=')[1]
                return io.BytesIO(('<title>%s</title>' % self.playlists.get(pid, {}).get('title', '')).encode() if self.playlists.get(pid, {}).get('public', True) else b'')
            authuser = int(url.split('authuser=')[1])
            return io.BytesIO(self.page(authuser))
        endpoint = url.split('/youtubei/v1/')[1].split('?')[0]
        body = json.loads(req.data)
        authuser = int(req.headers['X-goog-authuser'])
        if endpoint == 'account/account_menu':
            acct = self.accounts.get(authuser)
            return io.BytesIO(json.dumps({'header': {'activeAccountHeaderRenderer': {'accountName': {'simpleText': acct['name']}, 'channelHandle': {'simpleText': acct['handle']}}}} if acct else {}).encode())
        if endpoint == 'browse':
            return io.BytesIO(json.dumps(self.browse(body)).encode())
        self.writes.append((endpoint, body))
        if endpoint == 'playlist/create':
            pid = 'PL' + str(len(self.playlists))
            self.playlists[pid] = {'title': body['title'], 'items': list(body['videoIds'])}
            return io.BytesIO(json.dumps({'playlistId': pid}).encode())
        if endpoint == 'browse/edit_playlist':
            for a in body['actions']:
                if a['action'] == 'ACTION_ADD_VIDEO':
                    self.playlists[body['playlistId']]['items'].append(a['addedVideoId'])
            return io.BytesIO(b'{}')
        raise AssertionError(endpoint)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.cookies = os.path.join(self.dir.name, 'cookies.txt')
        open(self.cookies, 'w').write(COOKIES)

    def tearDown(self):
        self.dir.cleanup()

    def test_only_youtube_cookies_are_sent(self):
        jar = yt.load_cookies(self.cookies)
        self.assertEqual(jar, {'SAPISID': 'yt-value', 'SID': 'yt-sid'})

    def test_no_sign_in_is_refused(self):
        open(self.cookies, 'w').write('.youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tx\n')
        with self.assertRaises(yt.Refusal):
            yt.load_cookies(self.cookies)
        with self.assertRaises(yt.Refusal):
            yt.load_cookies(os.path.join(self.dir.name, 'missing.txt'))

    def test_reads_every_page_and_resolves_the_account_by_handle(self):
        fake = FakeYouTube({0: {'name': 'A', 'handle': '@a'}, 3: {'name': 'B', 'handle': '@b'}}, {'WL': {'items': ['w1', 'w2', 'w3', 'w4', 'w5']}})
        with mock.patch.object(yt.urllib.request, 'urlopen', fake.urlopen):
            c = yt.client_for(self.cookies, {'slug': 'b', 'sign_in_as': '@b', 'page_id': None})
            self.assertEqual(c.authuser, 3)
            items, _h, _r = yt.playlist_items(c, 'VLWL')
            self.assertEqual([i['id'] for i in items], ['w1', 'w2', 'w3', 'w4', 'w5'])
            self.assertEqual(items[0]['duration_seconds'], 61)
            with self.assertRaises(yt.Refusal):
                yt.client_for(self.cookies, {'slug': 'z', 'sign_in_as': '@nobody'}, most=4)

    def test_lockup_items_are_read_when_the_page_has_no_playlist_rows(self):
        lv = {'contentId': 'x1', 'contentType': 'LOCKUP_CONTENT_TYPE_VIDEO', 'metadata': {'lockupMetadataViewModel': {'title': {'content': 'Lockup'}, 'metadataRows': [{'metadataParts': [{'text': {'content': 'Chan'}}]}, {'metadataParts': [{'text': {'content': '5 views'}}, {'text': {'content': '1 day ago'}}]}]}}, 'contentImage': {'thumbnailBadgeViewModel': {'text': '2:00'}}}
        self.assertEqual(yt.parse_lockup(lv, 1)['views'], '5 views • 1 day ago')
        self.assertEqual(yt.parse_lockup(lv, 1)['duration'], '2:00')

    def test_list_accounts_and_read_channel(self):
        fake = FakeYouTube({0: {'name': 'A', 'handle': '@a'}}, {'WL': {'items': ['w1']}, 'PLx': {'title': 'Old', 'items': []}})
        with mock.patch.object(yt.urllib.request, 'urlopen', fake.urlopen):
            out = list_signed_in_accounts.run({'cookies': self.cookies, 'authusers': 2})
            self.assertEqual(out, {'signed_in': True, 'accounts': [{'authuser': 0, 'name': 'A', 'email': None, 'handle': '@a'}, {'authuser': 1, 'none': True}]})
            got = read_channel.run({'cookies': self.cookies, 'out_dir': self.dir.name, 'channels': [{'slug': 'a', 'label': 'A', 'sign_in_as': '@a'}]})
            self.assertEqual(got['channels'][0]['watch_later'], 1)
            self.assertEqual(json.load(open(os.path.join(self.dir.name, 'a', 'playlists.json')))['items'][0]['title'], 'Old')
            self.assertEqual(json.load(open(os.path.join(self.dir.name, 'a', 'subscriptions.json')))['count'], 1)
            settings = {'channels': [{'slug': 'b', 'label': 'B', 'sign_in_as': '@a'}]}
            got = read_channel.run({'cookies': self.cookies, 'out_dir': self.dir.name, 'settings': settings})
            self.assertEqual([c['slug'] for c in got['channels']], ['b'])


class ApplyAndVerifyTests(ClientTests):
    def plan(self, items):
        p = {'accounts': [{'slug': 'a', 'channel': 'A', 'authuser': 0, 'page_id': None, 'email': 'e', 'sign_in_as': '@a', 'watch_later_count': 3,
                           'playlists': [{'key': 'k', 'title': 'Bread', 'description': 'Loaves.', 'items': [{'id': v} for v in items]}, {'key': 'old', 'title': 'Old', 'description': '', 'items': [{'id': 'w1'}]}]}]}
        path = os.path.join(self.dir.name, 'plan.json')
        json.dump(p, open(path, 'w'))
        return path

    def test_creates_adds_only_missing_reuses_and_is_safe_to_rerun(self):
        fake = FakeYouTube({0: {'name': 'A', 'handle': '@a'}}, {'WL': {'items': ['w1', 'w2', 'w3']}, 'PLold': {'title': 'Old', 'items': []}})
        applied = os.path.join(self.dir.name, 'applied.json')
        req = {'cookies': self.cookies, 'plan_file': self.plan(['w1', 'w2', 'w3']), 'applied_file': applied, 'batch': 2}
        with mock.patch.object(yt.urllib.request, 'urlopen', fake.urlopen):
            out = apply_sort.run(req)
            self.assertEqual([(p['title'], p['created'], p['reused'], p['added_now']) for p in out['playlists']], [('Bread', True, False, 1), ('Old', False, True, 1)])
            new_id = out['playlists'][0]['id']
            self.assertEqual(fake.playlists[new_id]['items'], ['w1', 'w2', 'w3'])
            self.assertEqual(fake.playlists['PLold']['items'], ['w1'])
            self.assertFalse([w for w in fake.writes if 'REMOVE' in json.dumps(w)])
            writes = len(fake.writes)
            again = apply_sort.run(req)
            self.assertEqual([p['added_now'] for p in again['playlists']], [0, 0])
            self.assertEqual(len(fake.writes), writes)
            self.assertEqual(json.load(open(applied))['accounts']['a']['playlists']['k']['id'], new_id)

            os.makedirs(os.path.join(self.dir.name, 'acc', 'a'))
            json.dump({'count': 3, 'items': [video(v, 'T ' + v, 'C', '') for v in ['w1', 'w2', 'w3']]}, open(os.path.join(self.dir.name, 'acc', 'a', 'watch-later.json'), 'w'))
            fake.playlists['PLold']['public'] = False
            v = verify_sort.run({'cookies': self.cookies, 'plan_file': req['plan_file'], 'applied_file': applied, 'accounts_dir': os.path.join(self.dir.name, 'acc')})
            self.assertEqual(v['watch_later'], [{'account': 'a', 'before': 3, 'after': 3}])
            self.assertEqual(v['problems'], [{'account': 'a', 'title': 'Old', 'planned': 1, 'actual': 1, 'public': False}])
            tsv = open(v['table']).read().splitlines()
            self.assertEqual(tsv[1].split('\t')[:3], ['https://www.youtube.com/watch?v=w1', 'a', 'Bread | Old'])
            self.assertIn('| A: Bread | https://www.youtube.com/playlist?list=' + new_id + ' | 3 | Loaves. |', open(v['index']).read())

    def test_stops_when_a_recorded_playlist_reads_back_empty(self):
        fake = FakeYouTube({0: {'name': 'A', 'handle': '@a'}}, {'WL': {'items': []}, 'PLgone': {'title': 'Bread', 'items': []}})
        applied = os.path.join(self.dir.name, 'applied.json')
        json.dump({'accounts': {'a': {'channel': 'A', 'playlists': {'k': {'title': 'Bread', 'id': 'PLgone', 'added': ['w1']}}}}}, open(applied, 'w'))
        with mock.patch.object(yt.urllib.request, 'urlopen', fake.urlopen):
            with self.assertRaises(yt.Refusal):
                apply_sort.run({'cookies': self.cookies, 'plan_file': self.plan(['w1']), 'applied_file': applied})
        self.assertEqual(fake.writes, [])

    def test_signed_out_is_refused_before_any_write(self):
        fake = FakeYouTube({0: {'name': 'A', 'handle': '@a'}}, {'WL': {'items': []}}, signed_in=False)
        with mock.patch.object(yt.urllib.request, 'urlopen', fake.urlopen):
            with self.assertRaises(yt.Refusal) as e:
                apply_sort.run({'cookies': self.cookies, 'plan_file': self.plan(['w1']), 'applied_file': os.path.join(self.dir.name, 'applied.json')})
        self.assertIn('export-browser-login-cookies-for-yt-dlp', str(e.exception))
        self.assertEqual(fake.writes, [])


if __name__ == '__main__':
    unittest.main()
