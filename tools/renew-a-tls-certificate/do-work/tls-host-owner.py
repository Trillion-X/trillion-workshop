#!/usr/bin/python3
"""Retained-host TLS owner: maintained DNS-01 plugin, memory-only API credential.

Only certbot's exact challenge TXT lifecycle touches DNS. No address, proxy or
Worker mutation exists here. The Mac's source-owned launch agent re-injects the
vault token at renewal; no token or plaintext credential file lives on this host.
"""
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import pwd
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

OWNER = Path('/etc/trillion-public-tls')
SCRIPT = '/usr/local/lib/trillion/portable-tls-host.py'


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
    # This dedicated host uses the source-owned vault-fed job, not certbot's credential-file timer.
    run(['systemctl', 'disable', '--now', 'certbot.timer'])
    run(['systemctl', 'disable', '--now', 'nginx.service'])
    OWNER.mkdir(mode=0o700, exist_ok=True)
    if subprocess.run(['id', '-u', 'trillion-mcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        run(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'trillion-mcp'])
    return {'packages_installed': True, 'default_http_not_enabled': True, 'dns_credentials_on_disk': False}


def certificate(action, data):
    host = hostname(data['hostname'])
    token = data.get('token')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', token):
        raise ValueError('DNS API credential refused')
    fd = memory_file('trillion-dns-api-credential', f'dns_cloudflare_api_token = {token}\n'.encode())
    try:
        original_dns = dns_snapshot(host, token)
        with tempfile.TemporaryDirectory(prefix='trillion-certbot-', dir='/run') as logs:
            common = ['--non-interactive', '--dns-cloudflare-credentials', f'/proc/self/fd/{fd}', '--logs-dir', logs]
            if action == 'issue':
                args = ['certbot', 'certonly', '--dns-cloudflare', '--dns-cloudflare-propagation-seconds', '30', '--agree-tos', '--register-unsafely-without-email', '--cert-name', host, '-d', host, '--keep-until-expiring', *common]
            else:
                args = ['certbot', 'renew', '--cert-name', host, *common]
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
    if status['certificate_changed']:
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'trillion-mcp-receptionist.service']).returncode == 0:
            run(['systemctl', 'restart', 'trillion-mcp-receptionist.service'])
            verify_receptionist(host)
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'trillion-public-tls.service']).returncode == 0:
            run(['systemctl', 'reload', 'trillion-public-tls.service'])
    return status


def configure(data):
    host = hostname(data['hostname'])
    certificate_status(host)
    OWNER.mkdir(mode=0o700, exist_ok=True)
    config = data['nginx']
    if not isinstance(config, str) or len(config) > 65536:
        raise ValueError('Public proxy configuration refused')
    candidate = OWNER / 'nginx.next.conf'
    candidate.write_text(config); candidate.chmod(0o600)
    run(['nginx', '-t', '-c', str(candidate)])
    candidate.replace(OWNER / 'nginx.conf')
    units = Path('/etc/systemd/system')
    (units / 'trillion-public-tls.service').write_text('[Unit]\nDescription=Trillion public TLS ingress\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nExecStart=/usr/sbin/nginx -c /etc/trillion-public-tls/nginx.conf -g "daemon off;"\nExecReload=/usr/sbin/nginx -c /etc/trillion-public-tls/nginx.conf -s reload\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n')
    binary = data.get('receptionistBinary')
    if binary:
        if not re.fullmatch(r'/opt/trillion/source/[a-f0-9]{40}/target/release/trillion-mcp-receptionist', binary):
            raise ValueError('Retained receptionist artifact refused')
        (OWNER / 'receptionist.json').write_text(json.dumps({'hostname': host, 'binary': binary}))
        (OWNER / 'receptionist.json').chmod(0o600)
        (units / 'trillion-mcp-receptionist.service').write_text(f'[Unit]\nDescription=Trillion Rust MCP receptionist\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nExecStart=/usr/bin/python3 {SCRIPT} launch\nRestart=on-failure\nRestartSec=3\nUMask=0077\nLimitCORE=0\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'trillion-public-tls.service'])
    run(['systemctl', 'reload', 'trillion-public-tls.service'])
    return {'public_tls_configured': True, 'hostname': host, 'receptionist_configured': bool(binary), 'traffic_cutover': False}


def launch():
    data = json.loads((OWNER / 'receptionist.json').read_text())
    host, binary = hostname(data['hostname']), data['binary']
    if not re.fullmatch(r'/opt/trillion/source/[a-f0-9]{40}/target/release/trillion-mcp-receptionist', binary):
        raise ValueError('Retained receptionist artifact refused')
    password = secrets.token_urlsafe(48).encode()
    password_fd = memory_file('trillion-tls-password', password)
    live = Path('/etc/letsencrypt/live') / host
    try:
        p12 = run(['openssl', 'pkcs12', '-export', '-in', str(live / 'fullchain.pem'), '-inkey', str(live / 'privkey.pem'), '-passout', f'fd:{password_fd}'], pass_fds=(password_fd,)).stdout
        p12_fd = memory_file('trillion-tls-identity', p12)
        # Preserve both sources before replacing their required 3/4 slots.
        first = fcntl.fcntl(p12_fd, fcntl.F_DUPFD_CLOEXEC, 10)
        second = fcntl.fcntl(password_fd, fcntl.F_DUPFD_CLOEXEC, 10)
        os.lseek(second, 0, os.SEEK_SET)
        os.dup2(first, 3, inheritable=True); os.dup2(second, 4, inheritable=True)
        env = {**os.environ, 'TRILLION_MCP_LISTEN': '127.0.0.1:9443', 'TRILLION_MCP_PUBLIC_HOST': host, 'TRILLION_MCP_ISSUER_ORIGIN': f'https://{host}'}
        account = pwd.getpwnam('trillion-mcp')
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
    elif action == 'activate':
        run(['systemctl', 'enable', 'trillion-mcp-receptionist.service'])
        run(['systemctl', 'restart', 'trillion-mcp-receptionist.service'])
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
