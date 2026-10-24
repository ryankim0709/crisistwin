export type NavigationItem = {
  path: string;
  label: string;
  group: "Workspace" | "Analysis";
};

export const navigationItems: readonly NavigationItem[] = [
  {
    path: "/",
    label: "Overview",
    group: "Workspace",
  },
  {
    path: "/maps",
    label: "Map & simulation",
    group: "Workspace",
  },
  {
    path: "/scenarios",
    label: "Scenarios",
    group: "Workspace",
  },
  {
    path: "/evacuation",
    label: "Evacuation planning",
    group: "Workspace",
  },
  {
    path: "/comparison",
    label: "Strategy comparison",
    group: "Analysis",
  },
  {
    path: "/incidents",
    label: "Incident intelligence",
    group: "Analysis",
  },
  {
    path: "/replay",
    label: "Historical replay",
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
];
