set -eu
id "$service_user" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$service_user"
service_home=$(getent passwd "$service_user" | cut -d: -f6)
install -d -m 700 -o "$service_user" -g "$service_user" "$service_home/.ssh"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' "$service_port" "$service_public_key" > "$service_home/.ssh/authorized_keys"
chown "$service_user:$service_user" "$service_home/.ssh/authorized_keys"
chmod 600 "$service_home/.ssh/authorized_keys"
cat > "/etc/ssh/sshd_config.d/$service_user.conf" <<EOF
Match User $service_user
    AllowTcpForwarding remote
    GatewayPorts no
    PermitListen 127.0.0.1:$service_port
    PermitOpen none
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    ForceCommand /usr/bin/false
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    MaxSessions 0
EOF
/usr/sbin/sshd -t
systemctl reload ssh
printf 'tunnel-host-prepared: %s may listen only on 127.0.0.1:%s\n' "$service_user" "$service_port"
