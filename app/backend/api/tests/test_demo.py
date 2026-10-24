from django.test import SimpleTestCase

from api.demo import ISSUE_ORDERS_TOOL, ORDER_TYPES, build_index, parse_fire_rings, validate_orders, validate_request

OBSERVATION = {
    "clock": {"minute": 12},
    "fires": [{"id": "F1", "status": "burning"}, {"id": "F2", "status": "contained"}],
    "crews": [{"id": "E1"}, {"id": "E2"}],
    "zones": [
        {"id": "Z1", "options": [{"destination_id": "D1"}, {"destination_id": "D2"}]},
        {"id": "Z2", "options": []},
    ],
}


def order(**fields):
    base = {"type": None, "crew_id": None, "fire_id": None, "zone_id": None, "destination_id": None, "reason": "r"}
    return {**base, **fields}


class DemoOrderValidationTests(SimpleTestCase):
    def setUp(self):
        self.index = build_index(OBSERVATION)

    def test_tool_enum_matches_order_types(self):
        props = ISSUE_ORDERS_TOOL["input_schema"]["properties"]["orders"]["items"]["properties"]
        self.assertEqual(props["type"]["enum"], ORDER_TYPES)

    def test_valid_orders_pass(self):
        orders, rejected, summary = validate_orders(
            {
                "summary": " ok ",
                "orders": [
                    order(type="send_crew", crew_id="E1", fire_id="F1"),
                    order(type="release_crew", crew_id="E2"),
                    order(type="order_evacuation", zone_id="Z1", destination_id="D2"),
                ],
            },
            self.index,
        )
        self.assertEqual(rejected, [])
        self.assertEqual(summary, "ok")
        self.assertEqual(orders[0], {"type": "send_crew", "crew_id": "E1", "fire_id": "F1", "reason": "r"})
        self.assertEqual(orders[2]["destination_id"], "D2")

    def test_rejects_unknown_ids_and_unsendable_fire(self):
        orders, rejected, _ = validate_orders(
            {
                "summary": "",
                "orders": [
                    order(type="send_crew", crew_id="E9", fire_id="F1"),
                    order(type="send_crew", crew_id="E1", fire_id="F2"),
                    order(type="order_evacuation", zone_id="Z1", destination_id="D3"),
                    order(type="order_evacuation", zone_id="Z2", destination_id="D1"),
                    order(type="launch", crew_id="E1"),
                ],
            },
            self.index,
        )
        self.assertEqual(orders, [])
        self.assertEqual(len(rejected), 5)
        self.assertIn("not burning", rejected[1]["reason"])

    def test_rejects_duplicate_crew_orders(self):
        orders, rejected, _ = validate_orders(
            {
                "summary": "",
                "orders": [
                    order(type="send_crew", crew_id="E1", fire_id="F1"),
                    order(type="release_crew", crew_id="E1"),
                ],
            },
            self.index,
        )
        self.assertEqual(len(orders), 1)
        self.assertIn("Duplicate", rejected[0]["reason"])

    def test_request_validation(self):
        self.assertIsInstance(validate_request({"observation": {"clock": {}}}), str)
        self.assertIs(validate_request({"observation": OBSERVATION}), OBSERVATION)


class DemoFireRingTests(SimpleTestCase):
    def test_closes_open_rings(self):
        rings = parse_fire_rings({"fires": [[[0, 0], [1, 0], [1, 1], [0, 1]]]})
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(len(rings[0]), 5)

    def test_rejects_bad_rings(self):
        self.assertIsInstance(parse_fire_rings({"fires": [[[0, 0], [1, 0]]]}), str)
        self.assertIsInstance(parse_fire_rings({"fires": [[[0, 0], [1, 0], [1, 1], [0, True]]]}), str)
        self.assertIsInstance(parse_fire_rings({"fires": [[[0, 0], [1, 0], [1, 1], [0, 999]]]}), str)
        self.assertIsInstance(parse_fire_rings({"rings": []}), str)
        self.assertEqual(parse_fire_rings({"fires": []}), [])
