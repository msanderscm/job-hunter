import { useEffect } from "react";
import type { ReactNode } from "react";
import { useHashRoute } from "./hooks/useHashRoute";
import { AuthProvider, useAuth } from "./auth";
import { JobsView } from "./views/JobsView";
import { ManageView } from "./views/ManageView";
import { UsersView } from "./views/UsersView";
import { LoginView } from "./views/LoginView";

/** Gates a route on an active session: loading shows a placeholder, anon redirects to /login. */
function RequireAuth({ route, children }: { route: string; children: ReactNode }) {
  const auth = useAuth();

  useEffect(() => {
    if (auth.status === "anon") {
      auth.requireLogin(route);
    }
  }, [auth.status, route, auth.requireLogin]);

  if (auth.status === "loading") {
    return (
      <div className="view">
        <p>Loading…</p>
      </div>
    );
  }
  if (auth.status === "anon") {
    return null;
  }
  return <>{children}</>;
}

function AppHeaderUser() {
  const auth = useAuth();

  if (auth.status === "loading") {
    return null;
  }
  if (auth.status === "in") {
    return (
      <div className="app-user">
        <span>Hi, {auth.user?.first_name}</span>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => void auth.logout()}
        >
          Log out
        </button>
      </div>
    );
  }
  return (
    <div className="app-user">
      <a href="#/login">Log in</a>
    </div>
  );
}

function AppContent() {
  const route = useHashRoute();
  const auth = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <span className="app-name">Job Digest</span>
          <div className="app-header-right">
            <nav className="app-nav">
              <a href="#/" className={route === "/" ? "active" : ""}>
                Jobs
              </a>
              <a href="#/manage" className={route === "/manage" ? "active" : ""}>
                Manage
              </a>
              {auth.status === "in" && (
                <a href="#/users" className={route === "/users" ? "active" : ""}>
                  Users
                </a>
              )}
            </nav>
            <AppHeaderUser />
          </div>
        </div>
      </header>
      <main className="app-main">
        {route === "/login" ? (
          <LoginView />
        ) : route === "/manage" ? (
          <RequireAuth route={route}>
            <ManageView />
          </RequireAuth>
        ) : route === "/users" ? (
          <RequireAuth route={route}>
            <UsersView />
          </RequireAuth>
        ) : (
          <JobsView />
        )}
      </main>
      <footer className="app-footer">
        <p>Fetches run daily at 11:00 and 18:00 UTC</p>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
