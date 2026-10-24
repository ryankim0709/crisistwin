import os
import re
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name: str, default: str) -> bool:
    value = os.environ.get(name, default).lower()
    if value not in {"true", "false"}:
        raise ImproperlyConfigured(f"{name} must be true or false.")
    return value == "true"


DEBUG = env_bool("DJANGO_DEBUG", "true")
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY is required when DJANGO_DEBUG=false.")
    SECRET_KEY = "insecure-local-development-only-crisistwin"

ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,backend").split(",")
    if host.strip()
]

INSTALLED_APPS = [
    "rest_framework",
    "api",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DEFAULT_EXCEPTION_REPORTER_FILTER = "config.errors.MongoSafeExceptionReporterFilter"
# Persistence uses PyMongo; no SQL-backed models, sessions, or migrations.
DATABASES = {}
# SECRET in the setting name makes Django redact the URI in debug error reports.
MONGODB_CONNECTION_SECRET = os.environ.get("MONGODB_URI", "").strip()
if not MONGODB_CONNECTION_SECRET.startswith(("mongodb://", "mongodb+srv://")):
    raise ImproperlyConfigured("Set MONGODB_URI to a mongodb:// or mongodb+srv:// connection string.")
MONGODB_DATABASE = os.environ.get("MONGODB_DATABASE", "crisistwin")
if not re.fullmatch(r"[A-Za-z0-9_-]{1,63}", MONGODB_DATABASE):
    raise ImproperlyConfigured("MONGODB_DATABASE must be 1–63 ASCII letters, digits, underscores, or hyphens.")
# Live drill (docs/live-reports.md, ADR 0011/0012). Secrets come from the environment only.
# Unset LIVE_CONTROLLER_TOKEN / LIVE_INVITE_CODE disable controller endpoints / responder join (403).
LIVE_CONTROLLER_TOKEN = os.environ.get("LIVE_CONTROLLER_TOKEN", "").strip()
LIVE_INVITE_CODE = os.environ.get("LIVE_INVITE_CODE", "").strip()
# Replay bundle path; empty means app/public/replays/camp-2018.json next to the backend.
LIVE_DRILL_BUNDLE = os.environ.get("LIVE_DRILL_BUNDLE", "").strip()
LIVE_RATIONALE_MODEL = os.environ.get("LIVE_RATIONALE_MODEL", "claude-opus-5-5").strip()
# Controller plug-in: rule | twin; empty = twin while the traffic twin builds, else rule.
LIVE_CONTROLLER = os.environ.get("LIVE_CONTROLLER", "").strip()
# Twin input packages (repo-relative or absolute); empty = the packages the Camp bundle was built from.
LIVE_TWIN_PACKAGE = os.environ.get("LIVE_TWIN_PACKAGE", "").strip()
LIVE_TWIN_ROADS_PACKAGE = os.environ.get("LIVE_TWIN_ROADS_PACKAGE", "").strip()
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
CSRF_COOKIE_SECURE = not DEBUG
X_FRAME_OPTIONS = "DENY"
