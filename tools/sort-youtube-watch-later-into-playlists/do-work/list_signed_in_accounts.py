import sys, json
sys.path.insert(0, __import__('os').path.dirname(__file__))
from ytc import *
for n in range(0, 8):
    try:
        c = Client(n); c.bootstrap()
        r = c.call('account/account_menu', {'deviceTheme': 'DEVICE_THEME_SELECTED', 'userInterfaceTheme': 'USER_INTERFACE_THEME_DARK'})
        hdr = next(walk(r, 'activeAccountHeaderRenderer'), None)
        if not hdr: print(n, 'no account'); continue
        name = hdr.get('accountName', {}).get('simpleText'); email = hdr.get('email', {}).get('simpleText')
        ch = hdr.get('channelHandle', {}).get('simpleText')
        print(n, name, email, ch)
    except Exception as e:
        print(n, 'ERR', str(e)[:150])
