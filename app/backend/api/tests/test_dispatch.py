from django.test import SimpleTestCase

from api.dispatch import ISSUE_ORDERS_TOOL, ORDER_TYPES, build_index, validate_orders

OBSERVATION = {
    "zones": [
        {"id": "Z1", "exit_options": [{"exit_id": "E1"}, {"exit_id": "E2"}]},
        {"id": "Z2", "exit_options": [{"exit_id": "E1"}]},
    ],
    "exits": [{"id": "E1"}, {"id": "E2"}],
    "units": [{"id": "U1"}],
}


def order(**fields):
    base = {
        "type": None,
        "zone_id": None,
        "exit_id": None,
        "after_zone_id": None,
        "unit_id": None,
        "task": None,
        "reason": "test",
    }
    return {**base, **fields}


class StageEvacuationValidationTests(SimpleTestCase):
    def setUp(self):
        self.index = build_index(OBSERVATION)

    def test_tool_schema_offers_staging(self):
        item = ISSUE_ORDERS_TOOL["input_schema"]["properties"]["orders"]["items"]
        self.assertIn("stage_evacuation", ORDER_TYPES)
        self.assertIn("after_zone_id", item["required"])

    def test_valid_stage_is_normalized(self):
        orders, rejected, _ = validate_orders(
            {
                "summary": "s",
                "orders": [
                    order(type="order_evacuation", zone_id="Z1", exit_id="E1"),
                    order(type="stage_evacuation", zone_id="Z2", exit_id="E1", after_zone_id="Z1"),
                ],
            },
            self.index,
        )
        self.assertEqual(rejected, [])
        self.assertEqual(
            orders[1],
            {
                "type": "stage_evacuation",
                "zone_id": "Z2",
                "exit_id": "E1",
                "after_zone_id": "Z1",
                "reason": "test",
            },
        )

    def test_stage_rejects_unknown_self_and_bad_exit(self):
        cases = [
            order(type="stage_evacuation", zone_id="Z2", exit_id="E1", after_zone_id="Z9"),
            order(type="stage_evacuation", zone_id="Z2", exit_id="E1", after_zone_id="Z2"),
            order(type="stage_evacuation", zone_id="Z2", exit_id="E2", after_zone_id="Z1"),
            order(type="stage_evacuation", zone_id="Z2", exit_id="E1", after_zone_id=None),
        ]
        for case in cases:
            orders, rejected, _ = validate_orders({"summary": "", "orders": [case]}, self.index)
            self.assertEqual(orders, [], case)
            self.assertEqual(len(rejected), 1, case)

    def test_one_zone_order_per_zone(self):
        orders, rejected, _ = validate_orders(
            {
                "summary": "",
                "orders": [
                    order(type="order_evacuation", zone_id="Z1", exit_id="E1"),
                    order(type="stage_evacuation", zone_id="Z1", exit_id="E2", after_zone_id="Z2"),
                ],
            },
            self.index,
        )
        self.assertEqual(len(orders), 1)
        self.assertIn("Duplicate", rejected[0]["reason"])
