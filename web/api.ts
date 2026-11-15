import { Session, clearSession, loadSession, refresh } from "./auth";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

// Returns a session with a token that is valid for at least another minute.
async function freshSession(): Promise<Session | null> {
  const session = loadSession();
  if (!session) return null;
  if (session.expiresAt - Date.now() > 60_000) return session;
  try {
    return await refresh(session);
  } catch {
    clearSession();
    return null;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await freshSession();
  if (!session) throw new ApiError(401, "unauthorised");

  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? "request_failed"));
  return data as T;
}

