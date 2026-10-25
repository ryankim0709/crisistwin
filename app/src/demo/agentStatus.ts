import type { useDemoAgent } from "./useDemoAgent";

type Status = ReturnType<typeof useDemoAgent>["status"];

/** Tag tone and text for the AI commander's status (AgentControl). */
export const STATUS_TONE: Record<Status, "neutral" | "warning" | "success" | "info" | "danger"> = {
  off: "neutral",
  paused: "warning",
  watching: "success",
  thinking: "info",
  error: "danger",
};

export const STATUS: Record<Status, string> = {
  off: "Monitoring off",
  paused: "Paused: tab hidden",
  watching: "Monitoring",
  thinking: "Deciding",
  error: "Error",
};
