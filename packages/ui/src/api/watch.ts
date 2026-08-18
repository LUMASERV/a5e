import { apiUrl, authHeaders } from './client';

/**
 * Native `EventSource` can't attach an `Authorization` header — it only ever sends cookies, which
 * this app deliberately doesn't use for the session (see auth/routes.ts's rationale: bearer auth
 * is what lets the UI and API live on independent origins/domains). So SSE here is consumed via a
 * plain `fetch()` with the header set explicitly, manually parsing the `text/event-stream` framing
 * (frames separated by a blank line, `event:`/`data:` fields) — the same trade-off the original
 * plan flagged as the fallback bearer-auth would require.
 */
async function consumeSse(path: string, onEvent: (event: string, data: string) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(apiUrl(path), { headers: authHeaders(), signal });
  if (!res.ok || !res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd: number;
    while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
      }
      if (dataLines.length > 0) onEvent(event, dataLines.join('\n'));
    }
  }
}

export function watchResource(
  path: string,
  onEvent: (type: 'ADDED' | 'MODIFIED' | 'DELETED', object: unknown) => void,
): () => void {
  const controller = new AbortController();
  consumeSse(
    path,
    (event, data) => {
      if (event !== 'ADDED' && event !== 'MODIFIED' && event !== 'DELETED') return;
      try {
        onEvent(event, JSON.parse(data));
      } catch {
        // ignore malformed events
      }
    },
    controller.signal,
  ).catch(() => {
    // aborted (caller stopped watching) or a network error — nothing to recover here, the
    // resource store's next list()/watch() call will re-establish the stream
  });
  return () => controller.abort();
}

export function watchLogs(path: string, onLine: (line: string) => void, onError?: (message: string) => void): () => void {
  const controller = new AbortController();
  consumeSse(
    path,
    (event, data) => {
      if (event === 'log') {
        try {
          onLine(JSON.parse(data));
        } catch {
          // ignore malformed events
        }
      } else if (event === 'error') {
        try {
          onError?.(JSON.parse(data));
        } catch {
          onError?.(data);
        }
      }
    },
    controller.signal,
  ).catch(() => {
    // aborted or network error — same as watchResource above
  });
  return () => controller.abort();
}
