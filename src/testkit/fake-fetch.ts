/** A minimal route-matching stand-in for global fetch, for HTTP-layer tests. */
export interface FakeRoute {
  method: string;
  match: RegExp;
  status?: number;
  json?: unknown;
  text?: string;
  /** Optional: called on match, e.g. to count calls or vary responses. */
  onCall?: (url: string) => void;
}

export function fakeFetch(routes: FakeRoute[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) return new Response('no route', { status: 404 });
    route.onCall?.(url);
    const status = route.status ?? 200;
    const body = route.text ?? JSON.stringify(route.json ?? {});
    return new Response(body, { status });
  }) as typeof fetch;
}
