from unittest.mock import patch

from django.test import SimpleTestCase
from django.urls import reverse
from pymongo.errors import ConnectionFailure


class HealthTests(SimpleTestCase):
    @patch("api.views.get_database")
    def test_ready_contract(self, get_database):
        response = self.client.get(reverse("health"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "crisistwin-api", "version": "0.1.0"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        get_database.return_value.command.assert_called_once_with("ping")

    @patch("api.views.get_database")
    def test_database_failure_is_unavailable_without_exposing_details(self, get_database):
        get_database.return_value.command.side_effect = ConnectionFailure("private connection details")
        response = self.client.get(reverse("health"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_readiness_is_read_only(self):
        self.assertEqual(self.client.post(reverse("health"), {}).status_code, 405)
