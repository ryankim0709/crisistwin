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
    path: "/simulation",
    label: "Simulation Studio",
    group: "Workspace",
    description: "Schedule several fires and play their combined spread on one timeline.",
  },
  {
    path: "/dispatch",
    label: "Dispatch agent",
    group: "Workspace",
    description: "An AI dispatcher orders evacuations, redirects traffic and sends engines as the fire plays.",
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
    description: "Camp Fire what-if strategies compared with the baseline.",
  },
  {
    path: "/incidents",
    label: "Incident intelligence",
    group: "Analysis",
    description:
      "Browse the historical fires and review source evidence before proposing a scenario change.",
  },
  {
    path: "/replay",
    label: "Historical replay",
    group: "Analysis",
    description:
      "Replay past wildfire evacuations (Camp, Marshall, Kincade) with what-if comparisons.",
  },
  {
    path: "/simulate",
    label: "Agent simulation",
    group: "Analysis",
    description: "Modelled residents and responders, separate from the historical replay.",
  },
  {
    path: "/stress-tests",
    label: "Stress testing",
    group: "Analysis",
    description: "Camp Fire disruption runs and where the plan breaks.",
  },
  {
    path: "/diorama",
    label: "Evacuation diorama",
    group: "Analysis",
    description: "A fictional, scripted wildfire evacuation in miniature.",
  },
];
