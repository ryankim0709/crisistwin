import type { AgentSpend as Spend } from "./useDemoAgent";

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/**
 * "$X.XX · N calls · cache Y%" beside "Ask Claude now" once Claude has been called (hidden before). Costs are
 * the server's list-price estimate per call (api/dispatch.py decision_usage), summed since the page
 * loaded; cache hit is the share of prompt tokens read from the prompt cache.
 */
export default function AgentSpend({ spend }: { spend: Spend }) {
  const prompt = spend.inputTokens + spend.cacheReadTokens + spend.cacheWriteTokens;
  const hit = prompt > 0 ? Math.round((spend.cacheReadTokens / prompt) * 100) : null;
  if (spend.calls === 0) return null;
  const detail = `${spend.calls} call${spend.calls === 1 ? "" : "s"}${hit === null ? "" : ` · cache ${hit}%`}${
    spend.unpricedCalls ? ` · ${spend.unpricedCalls} unpriced` : ""
  }`;
  return (
    <p
      className="lc-agent-spend"
      title={`Claude spend this session, estimated at API list prices. Prompt tokens: ${tokens(spend.cacheReadTokens)} cache read, ${tokens(
        spend.cacheWriteTokens,
      )} cache write, ${tokens(spend.inputTokens)} uncached; ${tokens(spend.outputTokens)} output (with thinking).`}
    >
      Spend ${spend.costUsd.toFixed(2)} · {detail}
    </p>
  );
}
