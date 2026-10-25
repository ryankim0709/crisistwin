import { useEffect, useState, type ReactNode } from "react";
import { Button, IconButton } from "./ui";
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
  const title =
    navigationItems.find((item) => item.path === path)?.label ??
    (path === "/live/report" ? "After-action report" : "Page not found");

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
        <div className="sidebar-brand">
          <a className="sidebar-logo" href="/" aria-label="CrisisTwin home">
            <img className="sidebar-logo-full" src="/brand/crisistwin-logo.png" alt="" width={2172} height={724} />
            <img className="sidebar-logo-mark" src="/brand/crisistwin-mark-64.png" alt="" width={64} height={64} />
          </a>
          <IconButton
            className="sidebar-collapse"
            size="sm"
            variant="ghost"
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="workspace-navigation"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "»" : "«"}
          </IconButton>
          <Button
            className="menu-toggle"
            variant="secondary"
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close menu" : "Menu"}
          </Button>
        </div>
        <nav
          id="workspace-navigation"
          className={`sidebar-nav${menuOpen ? " is-open" : ""}`}
          aria-label="Primary navigation"
        >
          {(["Workspace"] as const).map((group) => (
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
                      </a>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}
