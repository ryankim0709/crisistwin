from pymongo.errors import PyMongoError
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .mongodb import get_database


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def health(request):
    """Readiness: the API can serve requests and MongoDB accepts a ping."""
    try:
        get_database().command("ping")
    except (PyMongoError, ValueError):
        return Response(
            {"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"},
            status=503,
            headers={"Cache-Control": "no-store"},
        )
    return Response(
        {"status": "ok", "service": "crisistwin-api", "version": "0.1.0"},
        headers={"Cache-Control": "no-store"},
    )
