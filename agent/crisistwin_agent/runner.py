"""The agent loop.

The Anthropic SDK's tool runner drives the request -> execute -> loop cycle over
the tools in :mod:`crisistwin_agent.tools`. This module adds the things a
planning tool needs around that loop: a hard turn ceiling so a run cannot
expand without bound, a transcript of what the model did, and explicit handling
of a safety refusal rather than a silent empty answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import anthropic

from .config import AgentConfig
from .domain import EvacuationAdvisory
from .prompts import WATCH_SYSTEM_PROMPT
from .tools import WatchSession, build_tools


@dataclass(slots=True)
class ToolCallRecord:
    """One tool the model invoked, for the run transcript."""

    name: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class WatchRunResult:
    """What one watch run produced."""

    final_text: str
    turns: int
    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    advisories: list[EvacuationAdvisory] = field(default_factory=list)
    truncated: bool = False
    """True when the run hit the turn ceiling before the model finished."""

    refusal_category: str | None = None
    """Set when the model declined; the run has no usable answer in that case."""

    @property
    def completed(self) -> bool:
        return not self.truncated and self.refusal_category is None


def _text_of(message: Any) -> str:
    parts = [block.text for block in message.content if getattr(block, "type", None) == "text"]
    return "\n".join(part for part in parts if part).strip()


def _tool_calls_of(message: Any) -> list[ToolCallRecord]:
    return [
        ToolCallRecord(name=block.name, arguments=dict(block.input or {}))
        for block in message.content
        if getattr(block, "type", None) == "tool_use"
    ]


def run_watch(
    session: WatchSession,
    instruction: str,
    config: AgentConfig | None = None,
    *,
    client: anthropic.Anthropic | None = None,
    system_prompt: str = WATCH_SYSTEM_PROMPT,
) -> WatchRunResult:
    """Run one watch cycle and return what the agent produced.

    Args:
        session: Ports and state for this run.
        instruction: What the planner asked for, in natural language.
        config: Model and loop settings. Defaults are in :class:`AgentConfig`.
        client: An Anthropic client, for injecting a configured or recorded one.
        system_prompt: Overrides the default watch prompt.
    """
    config = config or AgentConfig()
    if client is None:
        AgentConfig.require_anthropic_key()
        client = anthropic.Anthropic(timeout=config.request_timeout_seconds)

    runner = client.beta.messages.tool_runner(
        system=system_prompt,
        tools=build_tools(session),
        messages=[{"role": "user", "content": instruction}],
        # Stop the SDK's own loop at the ceiling too, so a runaway run cannot spend
        # one more request than the budget allows.
        max_iterations=config.max_turns,
        **config.request_kwargs(),
    )

    result = WatchRunResult(final_text="", turns=0)
    last_text = ""

    for message in runner:
        result.turns += 1
        result.tool_calls.extend(_tool_calls_of(message))

        text = _text_of(message)
        if text:
            last_text = text

        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            result.refusal_category = getattr(details, "category", None) or "unspecified"
            break

        if result.turns >= config.max_turns:
            # Bound expensive work rather than letting a loop run away. The partial
            # answer is still returned, flagged, so a planner can see it is partial.
            result.truncated = True
            break

    result.final_text = last_text
    result.advisories = list(session.advisories.values())
    return result


def summarize_run(result: WatchRunResult) -> str:
    """A short status line for the CLI, stating plainly whether the run finished."""
    if result.refusal_category is not None:
        return f"Run declined by the model (category: {result.refusal_category}). No usable result."
    if result.truncated:
        return f"Run hit the {result.turns}-turn ceiling before finishing. Result below is partial."
    drafted = len(result.advisories)
    advisory_note = f", {drafted} advisory draft(s)" if drafted else ", no advisory drafted"
    return f"Run finished in {result.turns} turn(s), {len(result.tool_calls)} tool call(s){advisory_note}."
