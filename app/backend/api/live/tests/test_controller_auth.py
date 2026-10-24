from django.test import RequestFactory, SimpleTestCase, override_settings

from api.live.auth import authenticate


class ControllerTokenTests(SimpleTestCase):
    """No controller token is needed unless LIVE_CONTROLLER_TOKEN is set."""

    def setUp(self):
        self.factory = RequestFactory()

    @override_settings(LIVE_CONTROLLER_TOKEN="")
    def test_untokened_request_is_the_controller_when_unset(self):
        principal = authenticate(self.factory.get("/api/live/incidents/camp-2018-drill/command"))
        self.assertEqual(principal.role, "controller")

    @override_settings(LIVE_CONTROLLER_TOKEN="secret")
    def test_untokened_request_is_refused_when_set(self):
        self.assertIsNone(authenticate(self.factory.get("/api/live/incidents/camp-2018-drill/command")))

    @override_settings(LIVE_CONTROLLER_TOKEN="secret")
    def test_matching_token_is_the_controller_when_set(self):
        request = self.factory.get("/", HTTP_AUTHORIZATION="Bearer secret")
        self.assertEqual(authenticate(request).role, "controller")
