const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Parse the optional email list shown while starting a Space. */
export function parseSpaceInviteEmails(value) {
  const entries = String(value ?? '').split(/[\n,;]/).map(email => email.trim()).filter(Boolean);
  const unique = [...entries.reduce((seen, email) => seen.has(email.toLowerCase()) ? seen : seen.set(email.toLowerCase(), email), new Map()).values()];
  const invalid = unique.find(email => !EMAIL.test(email));
  if (invalid) throw new Error(`Check this email address: ${invalid}`);
  return unique;
}
