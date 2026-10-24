import { useEffect, useState, type ReactNode } from "react";
import { navigationItems } from "./navigation";
import "./navigation.css";

type AppShellProps = { path: string; children: ReactNode };

export default function AppShell({ path, children }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = navigationItems.find((item) => item.path === path)?.label ?? "Page not found";

  useEffect(() => {
    document.title = `${title} · CrisisTwin`;
  }, [title]);

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace sidebar">
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
