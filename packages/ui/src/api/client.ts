import { apiOrigin } from './runtime-config';
import { getToken } from './token';

export interface ListResult<T> {
  items: T[];
  metadata: { resourceVersion?: string; continue?: string; remainingItemCount?: number };
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Builds the Authorization header from the stored bearer token — no cookies involved, so this
 * works the same whether the API is same-origin (proxied) or on its own separate domain. Exported
 * for the SSE (api/watch.ts) and authenticated-download call sites, which can't go through
 * `request()`'s JSON handling but still need the same header. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Full URL for a `/api/v1`-relative path — exported alongside authHeaders for the same reason. */
export function apiUrl(path: string): string {
  return `${apiOrigin()}/api/v1${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, body.error ?? `request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Triggers a browser download of an authenticated endpoint's response — a plain `<a href>`
 * can't attach the Authorization header, so this fetches the file with it, then hands the
 * browser a local blob: URL via a synthetic click (revoked immediately after). Follows redirects
 * transparently (e.g. the run-logs endpoint 302s to a presigned S3 URL when archived there) —
 * fetch() strips custom headers on cross-origin redirects by default, so the bearer token is
 * never sent to S3, only to this app's own API. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(apiUrl(path), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, body.error ?? `download failed: ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export const apiClient = {
  list<T>(path: string, params?: Record<string, string | undefined>): Promise<ListResult<T>> {
    const query = params
      ? `?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<string, string>).toString()}`
      : '';
    return request<ListResult<T>>(`${path}${query}`);
  },
  get<T>(path: string): Promise<T> {
    return request<T>(path);
  },
  create<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  },
  replace<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  },
  patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  },
  remove(path: string): Promise<void> {
    return request<void>(path, { method: 'DELETE' });
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  },
};

export { ApiError };
