/**
 * The home server's plain-HTTP addresses, and the HTTPS address (`tailscale serve`) that replaced
 * each on 2026-10-25. Over plain HTTP a network that fakes the server's name while Tailscale is
 * off would be sent the token; it can't fake the certificate.
 */
const REPLACED: Record<string, string> = {
  '8788': 'https://fedora.tail27f991.ts.net',
  '8096': 'https://fedora.tail27f991.ts.net:8920',
};

/** A saved or typed server address, moved to HTTPS when it's one of the old ones. */
export function homeServerHttps(url: string): string {
  const match = /^http:\/\/(?:fedora\.tail27f991\.ts\.net|100\.118\.162\.26):(\d+)\/?$/i.exec(url.trim());
  return (match && REPLACED[match[1]]) ?? url;
}
