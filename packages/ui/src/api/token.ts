const STORAGE_KEY = 'a5e:token';

/** In-memory cache backed by localStorage (so a page reload doesn't force a fresh login) — the
 * known trade-off of bearer-token SPA auth vs. an httpOnly cookie: this token is readable by any
 * JS running on the page, including an XSS payload. Chosen deliberately over cookies here so the
 * UI and API can be deployed on independent origins/domains (see charts/a5e's separate
 * ui.ingress/api.ingress) without a cross-site cookie needing SameSite=None. */
let cached: string | null = localStorage.getItem(STORAGE_KEY);

export function getToken(): string | null {
  return cached;
}

export function setToken(token: string | null): void {
  cached = token;
  if (token) localStorage.setItem(STORAGE_KEY, token);
  else localStorage.removeItem(STORAGE_KEY);
}
