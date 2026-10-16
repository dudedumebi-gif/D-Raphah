import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./functionality.css";
import "./workflows.css";
import "./monitoring.css";
import "./ux-fixes.css";
import { WorkflowsSection } from "./workflows";
import { MonitoringSection } from "./monitoring";
import { AuthProvider, LoginScreen, useAuth } from "./auth";

/* ── Delivery Factory shell (v2) ─────────────────────────────────────
 * Two real surfaces only: Monitoring (service health + intake) and
 * Automations (the workflow builder/runs). The browser-local demo
 * workspace (portfolio, projects, gates, evidence, audit explorer,
 * operations pages) was removed in v2 — it rendered seed data from
 * localStorage, not the backend. Backend records stay
 * environment-scoped; the app works in the production scope.
 */

type View = "monitoring" | "workflows";

const navItems: Array<{ id: View; label: string }> = [
  { id: "monitoring", label: "Monitoring" },
  { id: "workflows", label: "Automations" },
];

const viewTitles: Record<View, string> = {
  monitoring: "Monitoring",
  workflows: "Automations",
};

function App() {
  const auth = useAuth();
  const [view, setView] = useState<View>("monitoring");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="app-shell factory-shell env-production">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <span>Raphah</span>
        </div>
        <div className="product-label">
          DELIVERY FACTORY <span>v2</span>
        </div>
        <nav aria-label="Delivery Factory navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setView(item.id);
                setMobileNavOpen(false);
              }}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="user">
            <span>DM</span>
            <div>
              <b>Dude D.</b>
              <small>Delivery lead</small>
            </div>
            <i>•••</i>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="mobile-topbar-row">
            <button
              className="mobile-menu-button"
              aria-label="Open navigation"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
            >
              Menu
            </button>
            <span className="mobile-view-label">{viewTitles[view]}</span>
          </div>
          <div>
            <p className="eyebrow">Delivery operations / {viewTitles[view]}</p>
            <h1>{viewTitles[view]}</h1>
          </div>
        </header>
        {mobileNavOpen ? (
          <div
            className="mobile-nav-backdrop"
            role="presentation"
            onClick={() => setMobileNavOpen(false)}
          >
            <nav
              className="mobile-nav"
              aria-label="Delivery Factory navigation"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mobile-nav-head">
                <b>Navigate</b>
                <button
                  className="icon-button"
                  aria-label="Close navigation"
                  onClick={() => setMobileNavOpen(false)}
                >
                  ×
                </button>
              </div>
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className={view === item.id ? "nav-item active" : "nav-item"}
                  aria-current={view === item.id ? "page" : undefined}
                  onClick={() => {
                    setView(item.id);
                    setMobileNavOpen(false);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
        ) : null}
        <div className="status-bar" role="status" aria-live="polite">
          <span className="status-dot" />
          <span className="pilot-badge env-badge-production">Production</span>
          <span>
            Monitoring and Automations reflect the live Delivery Factory
            backend.
          </span>
          <span className="auth-email" title="Signed-in operator">
            {auth.email}
          </span>
          <button
            type="button"
            className="status-action"
            onClick={() => void auth.signOut()}
            title="Sign out of the operator account"
          >
            Sign out
          </button>
          {auth.error ? (
            <span className="auth-error" role="alert">
              {auth.error}
            </span>
          ) : null}
        </div>
        <div className="view-scroll">
          {view === "monitoring" ? (
            <MonitoringSection />
          ) : (
            <WorkflowsSection environment="production" />
          )}
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <GatedApp />
    </AuthProvider>
  </StrictMode>,
);

/** Operator login gate: the dashboard renders only with a live session. */
function GatedApp() {
  const auth = useAuth();
  if (auth.status === "loading") {
    return (
      <div className="auth-screen">
        <p className="muted">Checking operator session…</p>
      </div>
    );
  }
  if (auth.status === "signed-out") {
    return <LoginScreen />;
  }
  return <App />;
}
