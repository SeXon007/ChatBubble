import { net } from 'electron';

// net.fetch cancels a manual redirect instead of returning its headers. Expose
// redirects through ClientRequest so Updates can validate every next hostname.
export const updateFetch: typeof fetch = (input, init = {}) => new Promise((resolve, reject) => {
  if (init.signal?.aborted) { reject(new Error('Update request aborted')); return; }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
  let settled = false, bodyError: ((error: Error) => void) | undefined;
  const cleanup = (): void => init.signal?.removeEventListener('abort', abort);
  const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } bodyError?.(error); cleanup(); };
  const abort = (): void => { fail(new Error('Update request aborted')); request.abort(); };
  init.signal?.addEventListener('abort', abort, { once: true });
  new Headers(init.headers).forEach((value, name) => request.setHeader(name, value));
  request.on('error', fail);
  request.on('redirect', (status, _method, location) => {
    settled = true; cleanup();
    resolve(new Response(null, { status, headers: { Location: location } }));
    request.abort();
  });
  request.on('response', incoming => {
    if (settled) return;
    settled = true;
    const headers = new Headers();
    for (const [name, values] of Object.entries(incoming.headers)) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
    let finished = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyError = error => { if (!finished) { finished = true; controller.error(error); } };
        incoming.on('end', () => { if (!finished) { finished = true; controller.close(); } bodyError = undefined; cleanup(); });
        incoming.on('error', fail);
        incoming.on('aborted', () => fail(new Error('Update response aborted')));
        incoming.on('data', chunk => { if (!finished) controller.enqueue(new Uint8Array(chunk)); });
      },
      cancel() { finished = true; bodyError = undefined; cleanup(); request.abort(); }
    });
    if ([204, 205, 304].includes(incoming.statusCode)) { void body.cancel(); resolve(new Response(null, { status: incoming.statusCode, headers })); }
    else resolve(new Response(body, { status: incoming.statusCode, headers }));
  });
  request.end();
});
