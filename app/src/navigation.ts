export type PlannedPageDefinition = {
  path: string;
  label: string;
  group: "Workspace" | "Analysis";
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  plannedCapabilities: readonly string[];
};

export const plannedPages: readonly PlannedPageDefinition[] = [
  {
    path: "/scenarios",
    label: "Scenarios",
    group: "Workspace",
    description: "Set up repeatable experiments with shared assumptions.",
    emptyTitle: "No saved scenarios yet",
    emptyDescription:
      "Scenario saving is not connected yet. You can explore a temporary fire experiment on the map today.",
    plannedCapabilities: [
      "Capture ignition, weather, road closures, and shelter assumptions.",
      "Record model versions and source timestamps with each run.",
      "Reopen a baseline before testing a change.",
    ],
  },
  {
    path: "/evacuation",
    label: "Evacuation planning",
    group: "Workspace",
    description: "Explore how people, roads, and shelters interact during an evacuation.",
    emptyTitle: "No evacuation model connected",
    emptyDescription:
      "Population demand, road capacity, and shelter assignments are planned. No evacuation routes or travel times have been computed here.",
    plannedCapabilities: [
      "Configure neighborhood demand and departure windows.",
      "Introduce road closures and inspect queues and bottlenecks.",
      "Account for full shelters and unreachable destinations.",
    ],
  },
  {
    path: "/comparison",
    label: "Strategy comparison",
    group: "Analysis",
    description: "Compare candidate strategies against the same baseline.",
    emptyTitle: "No results to compare yet",
    emptyDescription:
      "Strategy comparison needs completed simulation runs. Clearance times, congestion, and exposure metrics are not available yet.",
    plannedCapabilities: [
      "Compare simultaneous departures with scheduled waves.",
      "Evaluate route and shelter allocations with numerical models.",
      "Show changed assumptions and the limitations of each comparison.",
    ],
  },
  {
    path: "/incidents",
    label: "Incident intelligence",
    group: "Analysis",
    description: "Review public evidence before using it in a hypothetical scenario.",
    emptyTitle: "No incident sources connected",
    emptyDescription:
      "Public-source ingestion is planned. This page does not currently monitor fires, road closures, or emergency alerts.",
    plannedCapabilities: [
      "Inspect source links, observation times, and verification status.",
      "Flag stale, conflicting, or ambiguous reports.",
      "Review a proposed scenario change before applying it.",
    ],
  },
  {
    path: "/stress-tests",
    label: "Stress testing",
    group: "Analysis",
    description: "Investigate where a plan becomes vulnerable as conditions change.",
    emptyTitle: "No stress tests run yet",
    emptyDescription:
      "Automated stress testing is not connected yet. Future findings will be grounded in simulation runs and their assumptions.",
    plannedCapabilities: [
      "Test additional road failures and wind shifts.",
      "Explore delayed departures and reduced shelter capacity.",
      "Explain bottlenecks and identify missing information.",
    ],
  },
];

export const navigationItems = [
  { path: "/", label: "Overview", group: "Workspace" },
  { path: "/maps", label: "Map & simulation", group: "Workspace" },
  ...plannedPages,
] as const;
