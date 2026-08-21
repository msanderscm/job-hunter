import { useHashRoute } from "./hooks/useHashRoute";
import { useAdminToken } from "./hooks/useAdminToken";
import { JobsView } from "./views/JobsView";
import { ManageView } from "./views/ManageView";

export function App() {
  const route = useHashRoute();
  const adminToken = useAdminToken();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <span className="app-name">Job Digest</span>
          <nav className="app-nav">
            <a href="#/" className={route === "/" ? "active" : ""}>
              Jobs
            </a>
            <a href="#/manage" className={route === "/manage" ? "active" : ""}>
              Manage
            </a>
          </nav>
        </div>
      </header>
      <main className="app-main">
        {route === "/manage" ? (
          <ManageView adminToken={adminToken} />
        ) : (
          <JobsView adminToken={adminToken} />
        )}
      </main>
      <footer className="app-footer">
        <p>Fetches run daily at 11:00 and 18:00 UTC</p>
      </footer>
    </div>
  );
}
