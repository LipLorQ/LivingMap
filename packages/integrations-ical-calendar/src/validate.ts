const MAX_ICAL_URL_LENGTH = 2000;

/**
 * https-only, no other scheme (no `javascript:`/`data:`/`file:`), reasonable max length (Stage 4
 * iCal decision §6). Deliberately not Google-domain-specific: any private https iCal feed works.
 */
export function isValidIcalFeedUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ICAL_URL_LENGTH) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
