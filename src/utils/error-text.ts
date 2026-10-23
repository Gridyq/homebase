/** What went wrong, for an alert or a line on screen. */
export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
