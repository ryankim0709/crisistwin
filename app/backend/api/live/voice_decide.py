"""Voice mode's fast decision path: Jev (TypeSafe) picks the action, a fixed policy decides
whether the phone files it on its own, asks first, or hands the turn to Claude.

Jev answers typed questions about one utterance with calibrated probabilities (``api/jev.py``).
``policy`` below is pure: the thresholds, what may be filed without asking, and every word the
phone says on this path are fixed here, so no model writes the reply. Claude still answers
questions and anything Jev is unsure about (``voice.py``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .. import jev

log = logging.getLogger(__name__)

AUTO_CONFIDENCE = 0.85
"""Intent and report kind must both reach this for the phone to file without asking."""
AUTO_FIRSTHAND = 0.8
"""...and Jev must think it is a first-hand account of something happening now."""
AUTO_HERE = 0.6
"""...at the person's own position: the phone pins the report there, so a place they name
elsewhere ("the gym is full") is proposed instead, and the person can move the pin."""
PROPOSE_CONFIDENCE = 0.6
"""Below this the turn goes to Claude."""
ANSWER_CONFIDENCE = 0.8
"""A yes or no to a pending proposal, or an undo, needs this."""
SEVERITY_CONFIDENCE = 0.6

AUTO_KINDS = frozenset(
    {"road_blocked", "road_passable", "heavy_traffic", "fire_seen", "heavy_smoke", "hazard_down", "shelter_full"}
)
"""Never filed without asking: ``help_needed`` (always confirmed, with the 911 line) and every
check-in (``need_help`` shares the person's position; check-ins cannot be taken back)."""

KINDS: dict[str, str] = {
    "road_blocked": "A road is blocked or closed (crash, debris, fallen tree, police closure)",
    "road_passable": "A road is open and passable, cars are getting through",
    "heavy_traffic": "Heavy or stopped traffic, a traffic jam",
    "fire_seen": "Flames or fire can be seen",
    "heavy_smoke": "Heavy smoke, hard to see or breathe",
    "hazard_down": "A power line, pole or tree is down",
    "shelter_full": "A shelter or evacuation center is full",
    "help_needed": "Someone else needs help (injured, trapped, cannot leave)",
}

INTENTS: dict[str, str | None] = {
    "report": "Tells what they see or what is happening around them (a road, traffic, fire, smoke, "
    "something down, a full shelter, someone who needs help)",
    "check_in": "Says they themselves have left the area, are staying put, or need help",
    "question": "Asks what to do, where to go, how long it takes, or about the situation",
    "open": "Asks to show the map, home, reports or plan, or to start directions",
    "undo": "Asks to take back, delete or cancel the report that was just sent",
    "other": None,
}

PHRASE: dict[str, str] = {
    "road_blocked": "a blocked road",
    "road_passable": "an open road",
    "heavy_traffic": "heavy traffic",
    "fire_seen": "fire",
    "heavy_smoke": "heavy smoke",
    "hazard_down": "a power line or tree down",
    "shelter_full": "a full shelter",
    "help_needed": "someone who needs help",
}
SEVERITY_PHRASE = {
    ("road_blocked", "full"): "a fully blocked road",
    ("road_blocked", "partial"): "a road down to one lane",
    ("road_blocked", "slow"): "a slow, partly blocked road",
    ("heavy_traffic", "full"): "traffic at a standstill",
    ("heavy_traffic", "slow"): "slow, heavy traffic",
}
STATUS_PHRASE = {"out": "out of the area", "staying": "staying where you are", "need_help": "needing help"}
SCREEN_REPLY = {
    "home": "Opening Home.",
    "map": "Opening the map.",
    "route": "Starting directions.",
    "reports": "Opening your reports.",
    "plan": "Opening your plan.",
}


@dataclass(frozen=True)
class Decision:
    reply: str
    action: dict[str, Any] | None
    auto: bool
    confidence: float
    model: str


def questions(has_pending: bool) -> dict[str, dict[str, Any]]:
    """One Jev call per utterance; every question reads the same state."""
    qs: dict[str, dict[str, Any]] = {
        "intent": jev.choice("What does the person want, going by `said`?", INTENTS),
        "kind": jev.choice("If `said` reports something, which kind is it?", {**KINDS, "none": None}),
        "severity": jev.choice(
            "How badly is the road or traffic in `said` affected?",
            {
                "full": "Completely blocked, nothing gets through, standstill",
                "partial": "One lane or one direction still open",
                "slow": "Moving, but slowly",
                "unknown": None,
            },
        ),
        "status": jev.choice(
            "If `said` is about the person themselves, which check-in fits?",
            {
                "out": "They have left the danger area, they are safe",
                "staying": "They are staying where they are",
                "need_help": "They themselves need help or cannot leave",
            },
        ),
        "screen": jev.choice("Which screen does `said` ask for?", {**SCREEN_REPLY, "none": None}),
        "firsthand": jev.noul(
            "Is `said` a first-hand account of something happening now, rather than a question, a "
            "hypothetical, or something heard from someone else?"
        ),
        "here": jev.noul(
            "Is what `said` describes at or right next to where the person is now, rather than at "
            "another place they name?"
        ),
    }
    if has_pending:
        qs["pending_reply"] = jev.choice(
            "`pending` is a report or check-in the phone just proposed and asked whether to send. "
            "How does `said` answer it?",
            {
                "yes": "Agrees: yes, send it, do it, correct",
                "no": "Declines: no, don't, cancel, never mind",
                "change": "Corrects or changes what was proposed",
                "other": None,
            },
        )
    return qs


def _choice(answers: dict[str, Any], key: str) -> tuple[str | None, float]:
    a = answers.get(key)
    if not isinstance(a, dict) or not isinstance(a.get("choice"), str):
        return None, 0.0
    try:
        return a["choice"], float(a.get("confidence") or 0.0)
    except (TypeError, ValueError):
        return a["choice"], 0.0


def _noul(answers: dict[str, Any], key: str) -> float:
    a = answers.get(key)
    try:
        return float(a.get("noul")) if isinstance(a, dict) else 0.0
    except (TypeError, ValueError):
        return 0.0


def policy(
    answers: dict[str, Any], transcript: str, pending: dict[str, Any] | None, model: str, note_limit: int
) -> Decision | None:
    """The phone's action and words from Jev's answers, or None to hand the turn to Claude."""
    if pending:
        reply, conf = _choice(answers, "pending_reply")
        if reply == "yes" and conf >= ANSWER_CONFIDENCE:
            return Decision("Sending it now.", {"type": "confirm"}, False, conf, model)
        if reply == "no" and conf >= ANSWER_CONFIDENCE:
            return Decision("Okay, I won't send it.", {"type": "cancel"}, False, conf, model)

    intent, intent_conf = _choice(answers, "intent")
    if intent is None or intent_conf < PROPOSE_CONFIDENCE or intent in ("question", "other"):
        return None
    if intent == "undo":
        if intent_conf < ANSWER_CONFIDENCE:
            return None
        return Decision("Okay, taking back your last report.", {"type": "undo"}, False, intent_conf, model)
    if intent == "open":
        screen, conf = _choice(answers, "screen")
        if screen not in SCREEN_REPLY or conf < PROPOSE_CONFIDENCE:
            return None
        return Decision(SCREEN_REPLY[screen], {"type": "open", "screen": screen}, False, min(intent_conf, conf), model)
    if intent == "check_in":
        status, conf = _choice(answers, "status")
        if status not in STATUS_PHRASE or conf < PROPOSE_CONFIDENCE:
            return None
        reply = f"Check you in as {STATUS_PHRASE[status]}? Say yes to send it."
        if status == "need_help":
            reply = "Check you in as needing help? That shares your location with responders. Say yes to send it."
        return Decision(reply, {"type": "check_in", "status": status}, False, min(intent_conf, conf), model)

    # intent == "report"
    kind, kind_conf = _choice(answers, "kind")
    if kind not in KINDS or kind_conf < PROPOSE_CONFIDENCE:
        return None
    severity = None
    if kind in ("road_blocked", "heavy_traffic"):
        sev, sev_conf = _choice(answers, "severity")
        if sev in ("full", "partial", "slow") and sev_conf >= SEVERITY_CONFIDENCE:
            severity = sev
    note = " ".join(transcript.split())[:note_limit] or None
    action = {"type": "report", "kind": kind, "severity": severity, "note": note}
    phrase = SEVERITY_PHRASE.get((kind, severity), PHRASE[kind])
    confidence = min(intent_conf, kind_conf)
    auto = (
        kind in AUTO_KINDS
        and confidence >= AUTO_CONFIDENCE
        and _noul(answers, "firsthand") >= AUTO_FIRSTHAND
        and _noul(answers, "here") >= AUTO_HERE
    )
    if auto:
        return Decision(
            f"Reported {phrase} at your location. Say undo to take it back.", action, True, confidence, model
        )
    return Decision(f"Report {phrase} at your location? Say yes to send it.", action, False, confidence, model)


def decide(transcript: str, context: dict[str, Any], note_limit: int) -> Decision | None:
    """Jev's decision for one utterance, or None (no key, Jev failed, or not confident enough)."""
    if not jev.is_configured() or not transcript.strip():
        return None
    history = context.get("history") or []
    state = {
        "said": transcript,
        "pending": context.get("pending"),
        "last_reply": history[-1]["agent"] if history else None,
        "guidance": (context.get("guidance") or {}).get("headline"),
    }
    try:
        answers, model = jev.system_one(state, questions(bool(context.get("pending"))))
    except jev.JevError as exc:
        log.warning("voice: Jev decision failed (%s)", exc.code)
        return None
    return policy(answers, transcript, context.get("pending"), model, note_limit)
