"""Which YouTube accounts a cookies file is signed in to, by account number (authuser), and whether the first is signed in.

Request: {"cookies": FILE, "authusers": 8}
Answers {"signed_in": bool, "accounts": [{"authuser", "name", "email", "handle"} | {"authuser", "none": true} | {"authuser", "error"}]}.
When signed_in is false, export the browser's login again (tool:export-browser-login-cookies-for-yt-dlp); a browser can
take a little while to refresh its login, so wait about 20 seconds and try again a few times before asking the person to sign in.
Ported from launch-video tools/yt-library/accounts_map.py, which printed the same table.
"""
import sys, json
sys.path.insert(0, __import__('os').path.dirname(__file__))
from youtube_client import Client, Refusal, answer, load_cookies, walk  # noqa: E402


def account_at(n):
    """The signed-in Google account at account number n: {authuser, name, email, handle}, or {authuser, none: true}."""
    c = Client(n); c.bootstrap()
    r = c.call('account/account_menu', {'deviceTheme': 'DEVICE_THEME_SELECTED', 'userInterfaceTheme': 'USER_INTERFACE_THEME_DARK'})
    hdr = next(walk(r, 'activeAccountHeaderRenderer'), None)
    if not hdr: return {'authuser': n, 'none': True}
    name = hdr.get('accountName', {}).get('simpleText'); email = hdr.get('email', {}).get('simpleText')
    ch = hdr.get('channelHandle', {}).get('simpleText')
    return {'authuser': n, 'name': name, 'email': email, 'handle': ch}


def run(req):
    if not req.get('cookies'):
        raise Refusal('name the cookies file as cookies (made by tool:export-browser-login-cookies-for-yt-dlp)')
    load_cookies(req['cookies'])
    signed_in = Client(0).signed_in()
    accounts = []
    for n in range(0, int(req.get('authusers', 8))):
        try:
            accounts.append(account_at(n))
        except Exception as e:  # one account number failing must not hide the others
            accounts.append({'authuser': n, 'error': str(e)[:150]})
    return {'signed_in': signed_in, 'accounts': accounts}


if __name__ == '__main__':
    sys.exit(answer(run))
