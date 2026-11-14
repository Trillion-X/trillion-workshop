#!/usr/bin/python3
"""Retained-host TLS owner: maintained DNS-01 plugin, memory-only API credential.

Only certbot's exact challenge TXT lifecycle touches DNS. No address, proxy or
Worker mutation exists here. The person's scheduled renewal hands the vault token
on each run; no token or plaintext credential file lives on this host.

Every fact about the product this host serves (its state folder, the ingress and
receptionist services, the receptionist's account, build pattern, listen address
and environment) is the layout file installed beside this owner (same name, .json),
written by the Mac side's installHostOwner from the run's input.

The receptionist's program follows a signed release feed (layout receptionist.releases): the program checks each release's
signature, content and target itself and switches `<folder>/<program>/current`; this owner only starts `current` (or the
seed, the one program the host started with, while `current` is absent or was rolled back), gives the program its own folder
to write, and keeps the feed's address in a file beside it. Nothing here builds or copies a release.
"""
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import pwd
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

SCRIPT = str(Path(__file__).resolve())


def layout():
    return json.loads(Path(SCRIPT).with_suffix('.json').read_text())


def owner_folder():
    return Path(layout()['state'])


def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def hostname(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', value):
        raise ValueError('TLS hostname refused')
    return value


def memory_file(name, value):
    fd = os.memfd_create(name, os.MFD_CLOEXEC)
    os.fchmod(fd, 0o600)
    os.write(fd, value)
    os.lseek(fd, 0, os.SEEK_SET)
    return fd


def certificate_status(host):
    live = Path('/etc/letsencrypt/live') / host
    if not (live / 'cert.pem').exists():
        return {'hostname': host, 'certificate_present': False}
    run(['openssl', 'verify', '-CAfile', '/etc/ssl/certs/ca-certificates.crt', '-untrusted', str(live / 'chain.pem'), '-verify_hostname', host, str(live / 'cert.pem')])
    run(['openssl', 'x509', '-checkend', '86400', '-noout', '-in', str(live / 'cert.pem')])
    details = dict(row.split('=', 1) for row in run(['openssl', 'x509', '-noout', '-dates', '-issuer', '-serial', '-in', str(live / 'cert.pem')]).stdout.decode().strip().splitlines())
    epoch = lambda date: int(datetime.strptime(date, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc).timestamp())
    mode = (live / 'privkey.pem').stat().st_mode & 0o777
    if mode != 0o600:
        raise ValueError('TLS private key must have mode 0600')
    return {'hostname': host, 'certificate_present': True, 'system_trust_and_hostname_verified': True, 'not_before_epoch_seconds': epoch(details['notBefore']), 'not_after_epoch_seconds': epoch(details['notAfter']), 'issuer': details['issuer'], 'serial': details['serial'], 'private_key_mode': '0600'}


def verify_receptionist(host):
    for attempt in range(10):
        try:
            answer = run(['curl', '--fail', '--silent', '--show-error', '--max-time', '3', '--resolve', f'{host}:443:127.0.0.1', f'https://{host}/.well-known/oauth-protected-resource/mcp'])
            document = json.loads(answer.stdout)
            if document.get('resource') == f'https://{host}/mcp' and f'https://{host}' in document.get('authorization_servers', []):
                return
        except (subprocess.CalledProcessError, ValueError):
            pass
        time.sleep(0.5)
    raise ValueError('Rust receptionist did not serve its canonical protected resource through verified public TLS')


def dns_snapshot(host, token):
    """Read records in memory to prove certbot preserved all pre-existing DNS."""
    def get(path):
        request = urllib.request.Request('https://api.cloudflare.com/client/v4/' + path, headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.load(response)
        if not answer.get('success'):
            raise ValueError('Cloudflare DNS preservation readback failed')
        return answer
    parts = host.split('.')
    zone = None
    for offset in range(len(parts) - 1):
        zones = get('zones?' + urllib.parse.urlencode({'name': '.'.join(parts[offset:])}))['result']
        if len(zones) == 1:
            zone = zones[0]['id']; break
    if not zone:
        raise ValueError('Cloudflare zone discovery or DNS edit permission failed')
    records = {}
    page = 1
    while True:
        answer = get(f'zones/{zone}/dns_records?per_page=100&page={page}')
        for row in answer['result']:
            records[row['id']] = row
        if page >= answer.get('result_info', {}).get('total_pages', 1):
            break
        page += 1
    return records


def setup():
    # Prevent newly installed packages exposing default HTTP or starting a tokenless renewal timer.
    policy = Path('/usr/sbin/policy-rc.d')
    created = not policy.exists()
    try:
        if created:
            policy.write_text('#!/bin/sh\nexit 101\n'); policy.chmod(0o755)
        run(['apt-get', 'update'], timeout=180)
        run(['apt-get', 'install', '-y', '--no-install-recommends', 'certbot', 'python3-certbot-dns-cloudflare', 'nginx', 'ca-certificates'], env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}, timeout=300)
    finally:
        if created:
            policy.unlink(missing_ok=True)
    # This dedicated host uses the person's vault-fed scheduled renewal, not certbot's credential-file timer.
    run(['systemctl', 'disable', '--now', 'certbot.timer'])
    run(['systemctl', 'disable', '--now', 'nginx.service'])
    owner_folder().mkdir(mode=0o700, exist_ok=True)
    account = layout()['receptionist']['account']
    if subprocess.run(['id', '-u', account], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        run(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', account])
    return {'packages_installed': True, 'default_http_not_enabled': True, 'dns_credentials_on_disk': False}


def certificate(action, data):
    host = hostname(data['hostname'])
    token = data.get('token')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', token):
        raise ValueError('DNS API credential refused')
    fd = memory_file('dns-api-credential', f'dns_cloudflare_api_token = {token}\n'.encode())
    try:
        original_dns = dns_snapshot(host, token)
        with tempfile.TemporaryDirectory(prefix='certbot-', dir='/run') as logs:
            common = ['--non-interactive', '--dns-cloudflare-credentials', f'/proc/self/fd/{fd}', '--logs-dir', logs]
            if action == 'issue':
                args = ['certbot', 'certonly', '--dns-cloudflare', '--dns-cloudflare-propagation-seconds', '30', '--agree-tos', '--register-unsafely-without-email', '--cert-name', host, '-d', host, '--keep-until-expiring', *common]
            else:
                args = ['certbot', 'renew', '--cert-name', host, *common, *(['--dry-run'] if data.get('dryRun') is True else [])]
            live = Path('/etc/letsencrypt/live') / host / 'cert.pem'
            before = live.read_bytes() if live.exists() else None
            try:
                result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(fd,), timeout=480)
            finally:
                if dns_snapshot(host, token) != original_dns:
                    raise ValueError('DNS changed during certificate work; preservation needs investigation before traffic cutover')
            if result.returncode:
                # Certificate errors are classified; neither API responses nor raw plugin logs escape.
                said = result.stdout + result.stderr
                if b'Invalid access token' in said or b'Invalid request headers' in said or b'Authentication error' in said:
                    raise ValueError('Cloudflare refused the held DNS API credential')
                if b'zone' in said.lower() and b'error' in said.lower():
                    raise ValueError('Cloudflare zone discovery or DNS edit permission failed')
                raise ValueError('ACME DNS-01 issuance or renewal failed; private provider diagnostic retained only for this process')
    finally:
        os.close(fd)
    status = certificate_status(host)
    status['preexisting_dns_records_unchanged'] = True
    status['certificate_changed'] = before != live.read_bytes()
    status['dry_run'] = data.get('dryRun') is True and action == 'renew'
    if status['certificate_changed']:
        receptionist, ingress = layout()['receptionist']['service'], layout()['ingress']['service']
        if subprocess.run(['systemctl', 'is-active', '--quiet', f'{receptionist}.service']).returncode == 0:
            run(['systemctl', 'restart', f'{receptionist}.service'])
            verify_receptionist(host)
        if subprocess.run(['systemctl', 'is-active', '--quiet', f'{ingress}.service']).returncode == 0:
            run(['systemctl', 'reload', f'{ingress}.service'])
    return status


def startable(binary):
    """Refuse a receptionist build the account `launch` drops to cannot start. Builds are root's and that account is
    neither root nor in root's group, so the file must be a regular file readable and executable by others, under
    folders others may pass through. A build left at 0700 (the build's umask) failed every launch with PermissionError
    while the public paths already pointed at it; it is now refused before anything is switched."""
    path = Path(binary)
    try:
        folders_open = all(folder.stat().st_mode & 0o001 for folder in path.parents)
        mode = path.stat().st_mode
    except (FileNotFoundError, NotADirectoryError):
        raise ValueError(f'Receptionist artifact {binary} is not on this host') from None
    if not (stat.S_ISREG(mode) and folders_open and mode & 0o005 == 0o005):
        raise ValueError(f'Receptionist artifact {binary} cannot be started by the account launch runs it as: '
                         f'make it readable and executable by others (chmod 0755 {binary}) first')
    return binary


def receptionist_binary(binary):
    if not re.fullmatch(layout()['receptionist']['binary_pattern'], binary):
        raise ValueError('Retained receptionist artifact refused')
    return binary


def releases():
    """The receptionist's release layout (`receptionist.releases`): {folder, program, feed: {urls, public_keys}, target,
    body_max_bytes, retire?}; None for a host whose receptionist is a fixed program."""
    return layout()['receptionist'].get('releases')


def release_program_folder(layout_releases):
    return Path(layout_releases['folder']) / layout_releases['program']


def release_feed_file(layout_releases):
    return Path(layout_releases['folder']) / 'release-feed.json'


def followed_binary(receptionist):
    """`<folder>/<program>/current/<program>` when the program has switched to a release it may start: a regular file the
    service account owns and may run. None otherwise: no `current` yet (or it was rolled back), so the seed starts."""
    layout_releases = receptionist.get('releases')
    if not layout_releases:
        return None
    program = release_program_folder(layout_releases) / 'current' / layout_releases['program']
    try:
        status, account = program.stat(), pwd.getpwnam(receptionist['account'])
    except (OSError, KeyError):
        return None
    if stat.S_ISREG(status.st_mode) and status.st_uid == account.pw_uid and status.st_mode & 0o100:
        return str(program)
    return None


def prepare_releases(receptionist):
    """The folder the program writes its releases into (its own, owned by the service account), and the feed file it reads
    (public: addresses and public keys, root-owned, readable by the service account)."""
    layout_releases = receptionist['releases']
    account = pwd.getpwnam(receptionist['account'])
    folder = Path(layout_releases['folder'])
    folder.mkdir(mode=0o755, parents=True, exist_ok=True)
    program = release_program_folder(layout_releases)
    program.mkdir(mode=0o755, exist_ok=True)
    os.chown(program, account.pw_uid, account.pw_gid)
    feed = release_feed_file(layout_releases)
    candidate = feed.with_suffix('.next')
    candidate.write_text(json.dumps({'urls': layout_releases['feed']['urls'], 'public_keys': layout_releases['feed']['public_keys'], 'releases': str(folder)}))
    candidate.chmod(0o644)
    candidate.replace(feed)
    return str(program)


def receptionist_unit(receptionist, writable):
    """The receptionist's unit. The system is read-only to it but for the one folder its releases are written in."""
    allowed = f'ReadWritePaths={writable}\n' if writable else ''
    return (f'[Unit]\nDescription=MCP receptionist\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nExecStart=/usr/bin/python3 {SCRIPT} launch\n'
            f'Restart=on-failure\nRestartSec=3\nUMask=0077\nLimitCORE=0\nNoNewPrivileges=true\nProtectSystem=strict\n{allowed}ProtectHome=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n')


def seed(data):
    """Put the newest release the feed names for this host's target at `<folder>/<program>/seed/<program>`: the program a host
    with no `current` starts, which then follows the feed itself and replaces it by a release it has verified. The fetch is
    https only and bounded by the entry's own length; the archive must hold the program alone, at its root. The seed's
    signature is not checked here (the program checks every release it takes); it is trusted only for the seconds before it does."""
    layout_releases = releases()
    if not layout_releases:
        raise ValueError('This host follows no release feed')
    def fetch(url, limit):
        if not url.startswith('https://'):
            raise ValueError('The release feed address is not https')
        with urllib.request.urlopen(urllib.request.Request(url), timeout=60) as response:
            body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError('A release download is larger than its bound')
        return body
    wanted = [entry for url in layout_releases['feed']['urls'] for entry in json.loads(fetch(url, 1 << 20))['releases'] if entry['target'] == layout_releases['target']]
    if not wanted:
        raise ValueError('The feed names no release for this host')
    entry = max(wanted, key=lambda one: one['sequence'])
    body = fetch(entry['url'], min(int(entry['bytes']), layout_releases['body_max_bytes']))
    if len(body) != int(entry['bytes']):
        raise ValueError('The release download is not the length its entry names')
    program = layout_releases['program']
    folder = release_program_folder(layout_releases) / 'seed'
    with tempfile.TemporaryDirectory(dir=release_program_folder(layout_releases)) as scratch:
        archive = Path(scratch) / 'body.tar.gz'
        archive.write_bytes(body)
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            if [member.name for member in members] != [program] or not members[0].isreg():
                raise ValueError('The release holds more than the program at its root')
            placed = Path(scratch) / program
            placed.write_bytes(tar.extractfile(members[0]).read())
        folder.mkdir(mode=0o755, parents=True, exist_ok=True)
        placed.chmod(0o755)
        placed.replace(folder / program)
    return {'seeded': True, 'commit': entry['commit'], 'sequence': entry['sequence'], 'binary': str(folder / program)}


def retire(data):
    """Remove the build folders the retired hand road left (`receptionist.releases.retire`: {folder, name}): each folder under
    it whose name matches `name`, but the one the seed runs from. Answers how many were removed."""
    layout_releases = releases()
    rule = (layout_releases or {}).get('retire')
    if not rule:
        raise ValueError('This host names no build folders to retire')
    holding = None
    try:
        holding = json.loads((owner_folder() / 'receptionist.json').read_text())['binary']
    except (OSError, ValueError, KeyError):
        pass
    removed = 0
    for folder in sorted(Path(rule['folder']).iterdir()):
        if folder.is_symlink() or not folder.is_dir() or not re.fullmatch(rule['name'], folder.name):
            continue
        if holding and (holding == str(folder) or holding.startswith(f'{folder}/')):
            continue
        shutil.rmtree(folder)
        removed += 1
    return {'retired': removed}


def roll_back(data):
    """Refuse the release `commit` (a 40-hex name) the program is running: the program's own `release roll-back` marks it so no
    host takes it again and points `current` at the release that was ready (or removes `current`, so the seed starts), run as
    the service account that owns the folder; then the receptionist restarts on what `current` names."""
    commit = data.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('The release to roll back must be a 40-hex commit')
    receptionist = layout()['receptionist']
    layout_releases = releases()
    if not layout_releases:
        raise ValueError('This host follows no release feed')
    binary = followed_binary(receptionist) or startable(receptionist_binary(json.loads((owner_folder() / 'receptionist.json').read_text())['binary']))
    account = pwd.getpwnam(receptionist['account'])
    answer = run([binary, 'release', 'roll-back', str(release_program_folder(layout_releases)), commit, *layout_releases['feed']['public_keys']], user=account.pw_uid, group=account.pw_gid, timeout=60)
    run(['systemctl', 'restart', f"{receptionist['service']}.service"])
    verify_receptionist(hostname(data['hostname']))
    return {'rolled_back': commit, **json.loads(answer.stdout.decode() or '{}')}


def configure(data):
    host = hostname(data['hostname'])
    # Checked before anything is replaced, so a receptionist that cannot start never takes the public paths.
    if data.get('receptionistBinary'):
        startable(receptionist_binary(data['receptionistBinary']))
    certificate_status(host)
    OWNER = owner_folder()
    OWNER.mkdir(mode=0o700, exist_ok=True)
    config = data['nginx']
    if not isinstance(config, str) or len(config) > 65536:
        raise ValueError('Public proxy configuration refused')
    candidate = OWNER / 'nginx.next.conf'
    candidate.write_text(config); candidate.chmod(0o600)
    run(['nginx', '-t', '-c', str(candidate)])
    candidate.replace(OWNER / 'nginx.conf')
    units = Path('/etc/systemd/system')
    ingress, receptionist = layout()['ingress']['service'], layout()['receptionist']['service']
    (units / f'{ingress}.service').write_text(f'[Unit]\nDescription=Public TLS ingress\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nExecStart=/usr/sbin/nginx -c {OWNER}/nginx.conf -g "daemon off;"\nExecReload=/usr/sbin/nginx -c {OWNER}/nginx.conf -s reload\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n')
    binary = data.get('receptionistBinary')
    if binary:
        (OWNER / 'receptionist.json').write_text(json.dumps({'hostname': host, 'binary': binary}))
        (OWNER / 'receptionist.json').chmod(0o600)
        (units / f'{receptionist}.service').write_text(receptionist_unit(layout()['receptionist'], prepare_releases(layout()['receptionist']) if releases() else None))
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', f'{ingress}.service'])
    run(['systemctl', 'reload', f'{ingress}.service'])
    return {'public_tls_configured': True, 'hostname': host, 'receptionist_configured': bool(binary), 'traffic_cutover': False}


def launch():
    data = json.loads((owner_folder() / 'receptionist.json').read_text())
    host, seed_binary = hostname(data['hostname']), receptionist_binary(data['binary'])
    receptionist = layout()['receptionist']
    # The release the program switched to, else the seed it started with.
    binary = followed_binary(receptionist) or startable(seed_binary)
    password = secrets.token_urlsafe(48).encode()
    password_fd = memory_file('tls-password', password)
    live = Path('/etc/letsencrypt/live') / host
    try:
        p12 = run(['openssl', 'pkcs12', '-export', '-in', str(live / 'fullchain.pem'), '-inkey', str(live / 'privkey.pem'), '-passout', f'fd:{password_fd}'], pass_fds=(password_fd,)).stdout
        p12_fd = memory_file('tls-identity', p12)
        # Preserve both sources before replacing their required 3/4 slots.
        first = fcntl.fcntl(p12_fd, fcntl.F_DUPFD_CLOEXEC, 10)
        second = fcntl.fcntl(password_fd, fcntl.F_DUPFD_CLOEXEC, 10)
        os.lseek(second, 0, os.SEEK_SET)
        os.dup2(first, 3, inheritable=True); os.dup2(second, 4, inheritable=True)
        env = {**os.environ, **{name: value.replace('{listen}', receptionist['listen']).replace('{hostname}', host) for name, value in receptionist['environment'].items()}}
        if receptionist.get('releases'):
            env['TRILLION_MCP_RELEASE_FEED'] = str(release_feed_file(receptionist['releases']))
        account = pwd.getpwnam(receptionist['account'])
        os.fchown(3, account.pw_uid, account.pw_gid); os.fchown(4, account.pw_uid, account.pw_gid)
        os.setgroups([]); os.setgid(account.pw_gid); os.setuid(account.pw_uid)
        os.execve(binary, [binary], env)
    finally:
        os.close(password_fd)


def main():
    action = sys.argv[1]
    if action == 'launch':
        launch(); return
    data = json.loads(sys.stdin.buffer.read(131072))
    host = hostname(data['hostname'])
    if action == 'setup': result = setup()
    elif action in ('issue', 'renew'): result = certificate(action, data)
    elif action == 'configure': result = configure(data)
    elif action == 'seed': result = seed(data)
    elif action == 'roll-back': result = roll_back(data)
    elif action == 'retire': result = retire(data)
    elif action == 'activate':
        receptionist = layout()['receptionist']['service']
        run(['systemctl', 'enable', f'{receptionist}.service'])
        run(['systemctl', 'restart', f'{receptionist}.service'])
        verify_receptionist(host)
        result = {'receptionist_active': True, 'protected_resource_served_through_verified_tls': True, 'traffic_cutover': False}
    elif action == 'status': result = certificate_status(host)
    else: raise ValueError('TLS action refused')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No subprocess buffers, tracebacks, request body or secret values in logs.
        message = str(error) if isinstance(error, ValueError) else f'{type(error).__name__}: portable TLS operation failed'
        print(json.dumps({'error': message})); sys.exit(1)
