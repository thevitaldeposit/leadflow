// Shared "can we actually email this?" test for the UI. Mirrors the server's
// emailService.isValidEmail so a button the client enables is never refused by the
// server's email-required guard (and vice versa). Used by every action that EMAILS
// something to a customer — the payment link on a booking, Approve & Send on an
// invoice — so none of them can proceed as if a message went out with nowhere to
// send it.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  if (value === null || value === undefined) return false;
  return EMAIL_RE.test(String(value).trim());
}
