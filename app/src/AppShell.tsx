import { useEffect, useState, type ReactNode } from "react";
import { navigationItems } from "./navigation";
import "./navigation.css";

type AppShellProps = { path: string; children: ReactNode };

const COLLAPSED_STORAGE_KEY = "crisistwin.sidebar.collapsed";

/** Remembered per browser; storage can be unavailable (private windows), so failures are ignored. */
function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function AppShell({ path, children }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const title = navigationItems.find((item) => item.path === path)?.label ?? "Page not found";

  useEffect(() => {
    document.title = `${title} · CrisisTwin`;
  }, [title]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // Preference only; the sidebar still works without storage.
    }
  }, [collapsed]);

  return (
    <div className={`app-layout${collapsed ? " is-sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace sidebar">
        <button
          className="sidebar-collapse"
          type="button"
          aria-expanded={!collapsed}
          aria-controls="workspace-navigation"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
        </button>
        <div className="sidebar-brand">
          <a className="sidebar-logo" href="/" aria-label="CrisisTwin home">
            <img src="/brand/crisistwin-logo.png" alt="" width={2172} height={724} />
          </a>
          <button
            className="menu-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close menu" : "Menu"}
          </button>
        </div>
        <nav
          id="workspace-navigation"
          className={`sidebar-nav${menuOpen ? " is-open" : ""}`}
          aria-label="Primary navigation"
        >
          {(["Workspace", "Analysis"] as const).map((group) => (
            <div className="nav-group" key={group}>
              <p className="nav-group-label" id={`nav-${group.toLowerCase()}`}>
                {group}
              </p>
              <ul aria-labelledby={`nav-${group.toLowerCase()}`}>
                {navigationItems
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <li key={item.path}>
                      <a href={item.path} aria-current={path === item.path ? "page" : undefined}>
                        <span>{item.label}</span>
                        {path === item.path && <span aria-hidden="true">→</span>}
                      </a>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="badge">Cal Hacks / Prototype</span>
          <p>Experimental planning only. Outputs are not operational evacuation instructions.</p>
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}
