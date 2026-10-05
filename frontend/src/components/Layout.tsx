import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PAGE_LABELS } from "../lib/pages";

export function Layout({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  const links = PAGE_LABELS.filter((entry) =>
    user?.allowedPages?.includes(entry.key),
  );

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <h2 className="topbar-title">Cafeteria Scanner</h2>
          <div className="right-actions">
            <span className="user-pill">
              {user?.username} · {user?.role}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => logout()}
            >
              Logout
            </button>
          </div>
        </div>
        <nav>
          {links.map((entry) => (
            <NavLink
              key={entry.path}
              to={`/${entry.path}`}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {entry.label}
            </NavLink>
          ))}
          {user?.allowedPages.includes("SCAN") && <NavLink to="/scanner-settings"
            className={({ isActive }) => isActive ? "active" : ""}>My Scanner Settings</NavLink>}
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
