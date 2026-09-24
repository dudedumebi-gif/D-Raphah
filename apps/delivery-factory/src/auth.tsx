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

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}
function emitUnauthorized(): void {
  for (const fn of [...unauthorizedListeners]) fn();
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
 * Resolve the operator JWT for the current browser session.
 *
 * better-auth's get-session returns an opaque session token, not a JWT, so
 * after confirming the session we mint a JWT: first from the `set-auth-jwt`
 * response header (emitted when the JWT plugin is active), otherwise from
 * the `/token` endpoint (JWT plugin). The JWT is what the DF API
 * verifies against the Neon Auth JWKS.
 */
async function loadOperatorJwt(
  authUrl: string,
): Promise<{ jwt: string; email: string | null }> {
  const sessRes = await fetch(`${authUrl}/get-session`, {
    credentials: "include",
  });
  if (!sessRes.ok) return { jwt: "", email: null };
  const sess = (await sessRes.json().catch(() => null)) as {
    user?: { email?: unknown };
  } | null;
  const email =
    sess && typeof sess.user?.email === "string" ? sess.user.email : null;
  const headerJwt = sessRes.headers.get("set-auth-jwt");
  if (headerJwt && headerJwt.split(".").length === 3) {
    return { jwt: headerJwt, email };
  }
  const tokRes = await fetch(`${authUrl}/token`, {
    credentials: "include",
  });
  if (!tokRes.ok) return { jwt: "", email };
  const tok = (await tokRes.json().catch(() => null)) as {
    token?: unknown;
  } | null;
  const jwt = tok && typeof tok.token === "string" ? tok.token : "";
  return { jwt, email };
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
      const { jwt, email: sessionEmail } = await loadOperatorJwt(authUrl);
      if (!jwt) {
        currentToken = null;
        setEmail(null);
        setStatus("signed-out");
        return;
      }
      currentToken = jwt;
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
  // drop back to the login screen instead of showing broken views.
  useEffect(
    () =>
      onUnauthorized(() => {
        if (statusRef.current === "signed-in") {
          currentToken = null;
          setEmail(null);
          setError("Session expired — please sign in again.");
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
    const { jwt, email: sessionEmail } = await loadOperatorJwt(authUrl);
    if (!jwt) {
      throw new Error("Signed in, but no operator token was issued.");
    }
    currentToken = jwt;
    setEmail(sessionEmail ?? signInEmail);
    setError(null);
    setStatus("signed-in");
  }, []);

  const signOut = useCallback(async () => {
    const authUrl = authUrlRef.current;
    if (authUrl) {
      await fetch(`${authUrl}/sign-out`, {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
    }
    currentToken = null;
    setEmail(null);
    setError(null);
    setStatus("signed-out");
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <AuthContext.Provider
      value={{ status, email, error, signIn, signOut, retry }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/** Full-screen operator login gate rendered when there is no session. */
export function LoginScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await auth.signIn(email.trim(), password);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <p className="eyebrow accent">Delivery Factory · Operators</p>
        <h1>Operator sign-in</h1>
        <p className="muted">
          Sign in with your operator account to manage workflows, projects and
          monitoring.
        </p>
        {auth.error ? <p className="auth-error">{auth.error}</p> : null}
        {formError ? <p className="auth-error">{formError}</p> : null}
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
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/** Notify the auth layer that an API call was rejected (401/403). */
export function notifyUnauthorized(): void {
  emitUnauthorized();
}
