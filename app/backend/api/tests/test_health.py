from unittest.mock import patch

from django.db import OperationalError
from django.test import SimpleTestCase
from django.urls import reverse


class HealthTests(SimpleTestCase):
    @patch("api.views.connection")
    def test_ready_contract(self, connection):
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (1,)
        response = self.client.get(reverse("health"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "crisistwin-api", "version": "0.1.0"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        cursor.execute.assert_called_once_with("SELECT 1")

    @patch("api.views.connection")
    def test_database_failure_is_unavailable_without_exposing_details(self, connection):
        connection.cursor.side_effect = OperationalError("private connection details")
        response = self.client.get(reverse("health"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_readiness_is_read_only(self):
        self.assertEqual(self.client.post(reverse("health"), {}).status_code, 405)
