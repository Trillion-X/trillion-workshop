import React from 'react';
import { Button } from '../../../../ui/show/button/Button';

// The booking card's first step, when the landing DATA names a before-booking address: an email (with a name, and how the booker
// heard of us, if they like) goes to that address as a plain form POST, so it works without JS. The address keeps the email as the
// booker's lead step and then sends them on to the booking address. The email is required, so the browser refuses an empty one before
// anything is sent (Nov 25 2026); a bad email that gets past it is still not refused by the address: the booker goes on, nothing kept.
export function BeforeBookingForm({ action, label }: { action: string; label: string }) {
  return (
    <form className="program-booking-form" method="post" action={action}>
      <label className="program-booking-field">
        <span>Email</span>
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label className="program-booking-field">
        <span>Name (optional)</span>
        <input type="text" name="name" autoComplete="name" />
      </label>
      <label className="program-booking-field">
        <span>How did you hear about us? (optional)</span>
        <input type="text" name="self_reported" />
      </label>
      <Button fullWidth size="lg" type="submit" variant="primary">{label}</Button>
    </form>
  );
}
