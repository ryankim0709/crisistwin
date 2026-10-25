"""Cartesia speech adapter: batch speech-to-text (ink-whisper) and text-to-speech (sonic).

Pure transport, stdlib ``urllib`` only, like ``intel_feeds``. The key stays server-side
(``CARTESIA_API_KEY``). The phone either posts audio for the batch calls here, or streams to
Cartesia's WebSockets itself with a short-lived ``stt``/``tts`` access token minted here. Paid usage.
API reference: https://docs.cartesia.ai/api-reference (version header below).
"""

from __future__ import annotations

import json
import os
import secrets
import urllib.error
import urllib.request

API_BASE = "https://api.cartesia.ai"
API_VERSION = "2026-08-14"
STT_MODEL = "ink-whisper"
DEFAULT_TTS_MODEL = "sonic-3.6"
# Cartesia's documented example voice; override with CARTESIA_VOICE_ID.
DEFAULT_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"
TTS_SAMPLE_RATE = 24_000
STT_SAMPLE_RATE = 16_000
HTTP_TIMEOUT_S = 20.0
MAX_TTS_CHARS = 600
ACCESS_TOKEN_TTL_S = 300


class CartesiaError(Exception):
    """A Cartesia call failed. ``code`` is ``unconfigured``, ``rejected``, ``upstream`` or ``unreachable``."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def api_key() -> str:
    return os.environ.get("CARTESIA_API_KEY", "").strip()


def is_configured() -> bool:
    return bool(api_key())


def _headers(content_type: str) -> dict[str, str]:
    key = api_key()
    if not key:
        raise CartesiaError("unconfigured", "Set CARTESIA_API_KEY in the shell that runs Django and restart it.")
    return {
        "Authorization": f"Bearer {key}",
        "Cartesia-Version": API_VERSION,
        "Content-Type": content_type,
    }


def _post(path: str, body: bytes, content_type: str) -> bytes:
    request = urllib.request.Request(f"{API_BASE}{path}", data=body, headers=_headers(content_type), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise CartesiaError("unconfigured", "Cartesia rejected the API key.") from exc
        if exc.code in (400, 413, 415, 422):
            raise CartesiaError("rejected", f"Cartesia did not accept the request (HTTP {exc.code}).") from exc
        raise CartesiaError("upstream", f"Cartesia returned HTTP {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CartesiaError("unreachable", "Could not reach Cartesia.") from exc


def transcribe(audio: bytes, filename: str = "speech.wav", language: str = "en") -> str:
    """The words in a WAV (or any container Cartesia reads) recording; may be empty."""
    boundary = f"----crisistwin{secrets.token_hex(12)}"
    parts: list[bytes] = []
    for name, value in (("model", STT_MODEL), ("language", language)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n".encode()
        + audio
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    raw = _post("/stt", b"".join(parts), f"multipart/form-data; boundary={boundary}")
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise CartesiaError("upstream", "Cartesia sent an unreadable transcript.") from exc
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str):
        raise CartesiaError("upstream", "Cartesia sent no transcript text.")
    return text.strip()


def synthesize(text: str, language: str = "en") -> bytes:
    """``text`` spoken as a 24 kHz 16-bit mono WAV."""
    body = {
        "model_id": tts_model(),
        "transcript": text[:MAX_TTS_CHARS],
        "voice": {"id": voice_id()},
        "language": language,
        "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": TTS_SAMPLE_RATE},
    }
    audio = _post("/tts/bytes", json.dumps(body).encode(), "application/json")
    if not audio.startswith(b"RIFF"):
        raise CartesiaError("upstream", "Cartesia sent audio in an unexpected format.")
    return audio


def tts_model() -> str:
    return os.environ.get("CARTESIA_TTS_MODEL", "").strip() or DEFAULT_TTS_MODEL


def voice_id() -> str:
    return os.environ.get("CARTESIA_VOICE_ID", "").strip() or DEFAULT_VOICE_ID


def mint_access_token(expires_in: int = ACCESS_TOKEN_TTL_S) -> str:
    """A short-lived token with only the ``stt`` and ``tts`` grants, for the phone's WebSockets.

    The phone streams to Cartesia directly with it (``access_token`` query parameter), so the
    API key never leaves the server and a leaked token stops working within minutes.
    """
    body = {"grants": {"stt": True, "tts": True, "agent": False}, "expires_in": expires_in}
    raw = _post("/access-token", json.dumps(body).encode(), "application/json")
    try:
        token = json.loads(raw).get("token")
    except (ValueError, AttributeError) as exc:
        raise CartesiaError("upstream", "Cartesia sent an unreadable access token.") from exc
    if not isinstance(token, str) or not token:
        raise CartesiaError("upstream", "Cartesia sent no access token.")
    return token
