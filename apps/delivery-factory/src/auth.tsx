import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type AuthStatus = "loading" | "signed-out" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  email: string | null;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  retry: () => void;
}

/* ---------------------------------------------------------------------------
 * Module-level token store. The api() fetch helpers in workflows.tsx and
 * monitoring.tsx are plain functions outside React, so they read the token
 * from here. The token lives only in memory — never localStorage — and is
 * re-issued from the auth cookie on every page load.
 * ------------------------------------------------------------------------- */
let currentToken: string | null = null;
export function getAuthToken(): string | null {
  return currentToken;
}

type UnauthorizedListener = (status?: number) => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}
function emitUnauthorized(status?: number): void {
  for (const fn of [...unauthorizedListeners]) fn(status);
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

async function readErrorMessage(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (data && typeof data.error === "string") return data.error;
  if (data && typeof data.message === "string") return data.message;
  return `Request failed (${res.status})`;
}

/**
 * Resolve the operator session for the current browser session.
 *
 * The better-auth session cookie is `Partitioned`, so the browser sends it
 * on this cross-origin `get-session` call. The response JSON carries the
 * opaque session token, which we keep in memory and send as
 * `Authorization: Bearer` on same-origin DF API calls. The DF backend
 * validates the token against the better-auth tables in its own database —
 * no JWT plugin involved.
 */
async function loadOperatorSession(
  authUrl: string,
): Promise<{ token: string; email: string | null }> {
  const sessRes = await fetch(`${authUrl}/get-session`, {
    credentials: "include",
  });
  if (!sessRes.ok) return { token: "", email: null };
  const sess = (await sessRes.json().catch(() => null)) as {
    session?: { token?: unknown };
    user?: { email?: unknown };
  } | null;
  const token =
    sess && typeof sess.session?.token === "string" ? sess.session.token : "";
  const email =
    sess && typeof sess.user?.email === "string" ? sess.user.email : null;
  return { token, email };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const authUrlRef = useRef<string | null>(null);
  const statusRef = useRef<AuthStatus>("loading");
  statusRef.current = status;

  const bootstrap = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const cfg = (await fetch("/api/config").then((r) => r.json())) as {
        authUrl?: unknown;
      };
      const authUrl =
        typeof cfg.authUrl === "string" && cfg.authUrl ? cfg.authUrl : null;
      if (!authUrl) {
        authUrlRef.current = null;
        currentToken = null;
        setEmail(null);
        setError("Operator sign-in is not configured (NEON_AUTH_URL).");
        setStatus("signed-out");
        return;
      }
      authUrlRef.current = authUrl;
      const { token, email: sessionEmail } = await loadOperatorSession(authUrl);
      if (!token) {
        currentToken = null;
        setEmail(null);
        setStatus("signed-out");
        return;
      }
      currentToken = token;
      setEmail(sessionEmail);
      setStatus("signed-in");
    } catch (e) {
      currentToken = null;
      setEmail(null);
      setError(e instanceof Error ? e.message : "Sign-in check failed.");
      setStatus("signed-out");
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap, attempt]);

  // A 401/403 from the DF API means the token is dead or not allowlisted:
  // drop back to the login screen instead of showing broken views. A 403
  // means the session was valid but the email is not an operator, so say
  // that rather than "session expired".
  useEffect(
    () =>
      onUnauthorized((status) => {
        if (statusRef.current === "signed-in") {
          currentToken = null;
          setEmail(null);
          setError(
            status === 403
              ? "Access denied — this operator account is not authorized."
              : "Session expired — please sign in again.",
          );
          setStatus("signed-out");
        }
      }),
    [],
  );

  const signIn = useCallback(async (signInEmail: string, password: string) => {
    const authUrl = authUrlRef.current;
    if (!authUrl) throw new Error("Operator sign-in is not configured.");
    const res = await fetch(`${authUrl}/sign-in/email`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: signInEmail, password }),
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const { token, email: sessionEmail } = await loadOperatorSession(authUrl);
    if (!token) {
      throw new Error("Signed in, but no operator session was established.");
    }
    currentToken = token;
    setEmail(sessionEmail ?? signInEmail);
    setError(null);
    setStatus("signed-in");
  }, []);

  const signUp = useCallback(async (signUpEmail: string, password: string) => {
    const authUrl = authUrlRef.current;
    if (!authUrl) throw new Error("Operator sign-in is not configured.");
    const res = await fetch(`${authUrl}/sign-up/email`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: signUpEmail,
        password,
        name: signUpEmail,
      }),
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const { token, email: sessionEmail } = await loadOperatorSession(authUrl);
    if (!token) {
      throw new Error("Account created, but no operator session was established.");
    }
    currentToken = token;
    setEmail(sessionEmail ?? signUpEmail);
    setError(null);
    setStatus("signed-in");
  }, []);

  const signOut = useCallback(async () => {
    const token = currentToken;
    const authUrl = authUrlRef.current;
    setError(null);
    // Authoritative revocation first: delete the session row via our own
    // API. This does not depend on the Neon Auth /sign-out endpoint.
    if (token) {
      let revoked = false;
      try {
        const res = await fetch("/api/sign-out", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        revoked = res.ok;
      } catch {
        revoked = false;
      }
      if (!revoked) {
        setError("Sign-out failed — please try again.");
        return;
      }
    }
    // Best-effort: also ask Neon Auth to clear its cookie. Ignored on
    // failure — the session row is already gone, so the cookie is dead.
    if (authUrl) {
      fetch(`${authUrl}/sign-out`, {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
    }
    currentToken = null;
    setEmail(null);
    setError(null);
    setStatus("signed-out");
  }, []);

  /**
   * Google social sign-in. better-auth redirects the browser to Google and
   * back to `callbackURL` (this app) with a session cookie; the normal
   * bootstrap then picks up the session token from that session. The DF API
   * allowlist check is unchanged — it only looks at the session's email.
   */
  const signInWithGoogle = useCallback(async () => {
    const authUrl = authUrlRef.current;
    if (!authUrl) throw new Error("Operator sign-in is not configured.");
    const res = await fetch(`${authUrl}/sign-in/social`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: window.location.origin,
      }),
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const data = (await res.json().catch(() => null)) as {
      url?: unknown;
    } | null;
    const url = data && typeof data.url === "string" ? data.url : null;
    if (!url) throw new Error("Google sign-in did not return a redirect URL.");
    window.location.href = url;
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <AuthContext.Provider
      value={{ status, email, error, signIn, signUp, signInWithGoogle, signOut, retry }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/** Full-screen operator login gate rendered when there is no session. */
export function LoginScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      if (mode === "signup") {
        await auth.signUp(email.trim(), password);
      } else {
        await auth.signIn(email.trim(), password);
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : mode === "signup"
            ? "Sign-up failed."
            : "Sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    setFormError(null);
    try {
      await auth.signInWithGoogle();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Google sign-in failed.",
      );
      setBusy(false);
    }
    // On success the browser leaves for Google; no finally needed.
  }

  function switchMode(next: "signin" | "signup") {
    setMode(next);
    setFormError(null);
  }

  const isSignup = mode === "signup";

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <p className="eyebrow accent">Delivery Factory · Operators</p>
        <h1>{isSignup ? "Create operator account" : "Operator sign-in"}</h1>
        <p className="muted">
          {isSignup
            ? "Create your operator account to manage workflows, projects and monitoring."
            : "Sign in with your operator account to manage workflows, projects and monitoring."}
        </p>
        {auth.error ? <p className="auth-error">{auth.error}</p> : null}
        {formError ? <p className="auth-error">{formError}</p> : null}
        <button
          type="button"
          className="btn-google"
          onClick={onGoogle}
          disabled={busy}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.1 0-5.8-2.1-6.8-5l-3.7 2.9c1.9 3.7 5.8 6.7 10.5 6.7z"
            />
            <path
              fill="#FBBC05"
              d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-3.7-2.9C.5 8.5 0 10.2 0 12s.5 3.5 1.5 5.1l3.7-2.7z"
            />
            <path
              fill="#EA4335"
              d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.4 2.7 1.5 6.7l3.7 2.9c1-2.9 3.7-4.9 6.8-4.9z"
            />
          </svg>
          {isSignup ? "Sign up with Google" : "Sign in with Google"}
        </button>
        <p className="muted auth-divider">
          <span>or with email</span>
        </p>
        <label className="auth-field">
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="operator@example.com"
          />
        </label>
        <label className="auth-field">
          Password
          <input
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy
            ? isSignup
              ? "Creating account…"
              : "Signing in…"
            : isSignup
              ? "Create account"
              : "Sign in"}
        </button>
        <p className="muted auth-switch">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => switchMode("signin")}>
                Sign in
              </button>
            </>
          ) : (
            <>
              No operator account yet?{" "}
              <button type="button" onClick={() => switchMode("signup")}>
                Create one
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}

/** Notify the auth layer that an API call was rejected (401/403). */
export function notifyUnauthorized(status?: number): void {
  emitUnauthorized(status);
}
