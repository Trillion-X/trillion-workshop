export function administrationArguments(c) {
  checked(c);
  if (!c.adminKeyFile) throw new Error('The host administration identity was refused.');
  return ['-T', '-i', c.adminKeyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsFile}`, '-o', 'ConnectTimeout=10', `root@${c.address}`];
}
