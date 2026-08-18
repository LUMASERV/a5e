/** Builds an SSE Response whose stream is fed by `subscribe`, closing cleanly when the client disconnects. */
export function sseResponse(
  signal: AbortSignal,
  subscribe: (send: (event: string, data: unknown) => void) => Promise<() => void>,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed (client disconnected) — subscription teardown handles it
        }
      };
      unsubscribe = await subscribe(send);
      if (signal.aborted) {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      unsubscribe?.();
    },
  });

  signal.addEventListener('abort', () => {
    unsubscribe?.();
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
