export function addGuests(list: readonly string[], text: string, max: number): { guests: string[]; invalid: string[]; over: string[] };
export function removeGuest(list: readonly string[], email: string): string[];
export function guestFields(list: readonly string[]): { attendees?: { email: string }[] };
