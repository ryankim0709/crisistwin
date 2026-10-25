export type NavigationItem = {
  path: string;
  label: string;
  group: "Workspace" | "Analysis";
};

// "Analysis" pages stay routable and keep their page titles, but are not listed in the
// sidebar; AppShell renders only the "Workspace" group.
export const navigationItems: readonly NavigationItem[] = [
  {
    path: "/fire",
    label: "Fire spread model",
    group: "Workspace",
  },
  {
    path: "/simulation",
    label: "Simulation Studio",
    group: "Workspace",
  },
  {
    path: "/dispatch",
    label: "Dispatch agent",
    group: "Workspace",
  },
  {
    path: "/live",
    label: "Live command",
    group: "Workspace",
  },
  {
    path: "/app-integration",
    label: "App integration",
    group: "Workspace",
  },
  {
    path: "/replay",
    label: "Historical replay",
    group: "Workspace",
  },
  {
    path: "/comparison",
    label: "Strategy comparison",
    group: "Analysis",
  },
  {
    path: "/intel",
    label: "Incident intelligence",
    group: "Analysis",
  },
  {
    path: "/simulate",
    label: "Agent simulation",
    group: "Analysis",
  },
  {
    path: "/stress-tests",
    label: "Stress testing",
    group: "Analysis",
  },
  {
    path: "/diorama",
    label: "Evacuation diorama",
    group: "Analysis",
  },
  {
    path: "/run",
    label: "Scenario run",
    group: "Analysis",
  },
];

/** Full-viewport pages AppShell renders bare: no sidebar, just the page (which carries id="main-content"). */
export const BARE_PATHS: ReadonlySet<string> = new Set(["/run"]);
