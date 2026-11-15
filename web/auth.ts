import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms since epoch
  email: string;
}

const STORAGE_KEY = "memeos.session";

async function authPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (data.msg as string) ||
      (data.error_description as string) ||
      (data.message as string) ||
      "Request failed";
    throw new Error(message);
  }
  return data as T;
}

function toSession(data: Record<string, unknown>, fallbackEmail: string): Session {
  const user = data.user as { email?: string } | undefined;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    email: user?.email ?? fallbackEmail,
  };
}

export async function signIn(email: string, password: string): Promise<Session> {
  const data = await authPost<Record<string, unknown>>("token?grant_type=password", { email, password });
  const session = toSession(data, email);
  saveSession(session);
  return session;
}

export async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const data = await authPost<Record<string, unknown>>("signup", { email, password });
  // If email confirmation is enabled Supabase returns no access token.
  if (!data.access_token) return { needsConfirmation: true };
  saveSession(toSession(data, email));
  return { needsConfirmation: false };
}

export async function requestPasswordReset(email: string): Promise<void> {
  await authPost("recover", { email, redirect_to: window.location.origin });
}

export async function refresh(session: Session): Promise<Session> {
  const data = await authPost<Record<string, unknown>>("token?grant_type=refresh_token", {
    refresh_token: session.refreshToken,
  });
  const next = toSession(data, session.email);
  saveSession(next);
  return next;
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// Sets a new password for the signed-in user. Works for the recovery session
// created by a reset link, and for normal sessions in Settings.
export async function updatePassword(accessToken: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((data.msg as string) || (data.error_description as string) || "Couldn't update password.");
  }
  const user = (await res.json()) as { email?: string };
  return user.email ?? "";
}

// Reads a recovery session from the URL hash that Supabase adds to reset links,
// then removes it from the address bar.
export function sessionFromRecoveryHash(): Session | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.get("type") !== "recovery") return null;
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return null;
  history.replaceState(null, "", window.location.pathname);
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Number(params.get("expires_in") ?? 3600) * 1000,
    email: "",
  };
}
