from django.db import DatabaseError, connection
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def health(request):
    """Readiness: the API can serve requests and PostgreSQL accepts a query."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError:
        return Response(
            {"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"},
            status=503,
            headers={"Cache-Control": "no-store"},
        )
    return Response(
        {"status": "ok", "service": "crisistwin-api", "version": "0.1.0"},
        headers={"Cache-Control": "no-store"},
    )
