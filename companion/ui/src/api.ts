export interface Playlist {
  id: string;
  title: string;
  trackCount: number;
  durationSeconds: number;
  selected: boolean;
  selectable: boolean;
  unavailableReason: string | null;
}

export interface PlexConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexServer {
  id: string;
  name: string;
  connections: PlexConnection[];
}

export interface PlexLibrary {
  id: string;
  title: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  csrf?: string | null;
  body?: unknown;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = response.status === 204 ? null : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { message?: string; code?: string } }).error
      : undefined;
    throw new ApiError(
      error?.message ?? "SyncAndRun could not complete that request.",
      response.status,
      error?.code ?? null
    );
  }
  return body as T;
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
