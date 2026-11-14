const bannedMoneyCopy = [
  'bet',
  'betting',
  'cashout',
  'deposit',
  'line movement',
  'odds',
  'payout',
  'stake',
  'wager',
  'wagering',
  'wallet',
  'withdrawal',
];

export function assertFreePickCopy(value: string, field: string): void {
  const normalized = value.toLowerCase();
  const banned = bannedMoneyCopy.find((term) => normalized.includes(term));
  if (banned) throw new Error(`${field} cannot contain regulated-money copy: ${banned}`);
}

export function freePickBannedCopyPattern(): RegExp {
  return new RegExp(bannedMoneyCopy.map((term) => term.replaceAll(' ', '\\s+')).join('|'), 'i');
}
