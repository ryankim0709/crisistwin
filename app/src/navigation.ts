export type NavigationItem = {
  path: string;
  label: string;
  group: "Workspace" | "Analysis";
  description: string;
};

export const navigationItems: readonly NavigationItem[] = [
  {
    path: "/",
    label: "Overview",
    group: "Workspace",
    description: "Workspace activity and service readiness.",
  },
  {
    path: "/maps",
    label: "Map & simulation",
    group: "Workspace",
    description: "Choose an ignition point and explore illustrative fire spread.",
  },
  {
    path: "/fire",
    label: "Fire spread model",
    group: "Workspace",
    description: "Rothermel surface spread over LANDFIRE fuels and terrain.",
  },
  {
    path: "/scenarios",
    label: "Scenarios",
    group: "Workspace",
    description: "Draft starting conditions and inspect reproducibility details.",
  },
  {
    path: "/evacuation",
    label: "Evacuation planning",
    group: "Workspace",
    description: "Configure population demand, departure timing, and shelters.",
  },
  {
    path: "/comparison",
    label: "Strategy comparison",
    group: "Analysis",
    description: "Prepare baseline and alternative strategies for comparison.",
  },
  {
    path: "/incidents",
    label: "Incident intelligence",
    group: "Analysis",
    description: "Review source evidence before proposing a scenario change.",
  },
  {
    path: "/stress-tests",
    label: "Stress testing",
    group: "Analysis",
    description: "Configure disruptions and investigate plan vulnerabilities.",
  },
];
