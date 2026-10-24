from django.test import SimpleTestCase

from api.dispatch import (
    ISSUE_ORDERS_TOOL,
    ORDER_TYPES,
    SYSTEM_PROMPT,
    build_index,
    validate_orders,
)

OBSERVATION = {
    "zones": [
        {"id": "Z1", "exit_options": [{"exit_id": "E1"}, {"exit_id": "E2"}]},
        {"id": "Z2", "exit_options": [{"exit_id": "E1"}]},
        {
            "id": "Z3",
            "status": "no_order",
            "impact": "outside",
            "exit_options": [{"exit_id": "E1"}],
        },
        {
            "id": "Z4",
            "status": "ordered",
            "impact": "outside",
            "exit_options": [{"exit_id": "E1"}, {"exit_id": "E2"}],
        },
    ],
    "exits": [{"id": "E1"}, {"id": "E2"}],
    "units": [{"id": "U1"}],
    "fires": [
        {
            "id": "F1",
            "status": "burning",
            "tactics_blocked": {"direct": None, "flank": None, "indirect": None},
        },
        {
            "id": "F2",
            "status": "burning",
            "tactics_blocked": {"direct": "it is crowning", "flank": None, "indirect": None},
        },
        {
            "id": "F3",
            "status": "out",
            "tactics_blocked": {"direct": None, "flank": None, "indirect": None},
        },
    ],
}


def order(**fields):
    base = {
        "type": None,
        "zone_id": None,
        "exit_id": None,
        "after_zone_id": None,
        "unit_id": None,
        "task": None,
        "fire_id": None,
        "tactic": None,
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


class FirePathScopeTests(SimpleTestCase):
    def setUp(self):
        self.index = build_index(OBSERVATION)

    def test_outside_zone_cannot_be_ordered_or_staged(self):
        cases = [
            order(type="order_evacuation", zone_id="Z3", exit_id="E1"),
            order(type="stage_evacuation", zone_id="Z3", exit_id="E1", after_zone_id="Z1"),
        ]
        for case in cases:
            orders, rejected, _ = validate_orders({"summary": "", "orders": [case]}, self.index)
            self.assertEqual(orders, [], case)
            self.assertIn("outside the fire path", rejected[0]["reason"])

    def test_already_ordered_outside_zone_can_be_redirected(self):
        orders, rejected, _ = validate_orders(
            {"summary": "", "orders": [order(type="order_evacuation", zone_id="Z4", exit_id="E2")]},
            self.index,
        )
        self.assertEqual(rejected, [])
        self.assertEqual(len(orders), 1)

    def test_prompt_scopes_evacuation_to_fire_path(self):
        self.assertIn('impact is "outside"', SYSTEM_PROMPT)


class FireAttackValidationTests(SimpleTestCase):
    def setUp(self):
        self.index = build_index(OBSERVATION)

    def test_tool_schema_offers_fire_attack(self):
        item = ISSUE_ORDERS_TOOL["input_schema"]["properties"]["orders"]["items"]
        self.assertIn("attack_fire", ORDER_TYPES)
        self.assertIn("fire_id", item["required"])
        self.assertIn("tactic", item["required"])

    def test_valid_attack_is_normalized(self):
        orders, rejected, _ = validate_orders(
            {"summary": "", "orders": [order(type="attack_fire", unit_id="U1", fire_id="F1")]},
            self.index,
        )
        self.assertEqual(rejected, [])
        # No tactic means direct attack.
        self.assertEqual(
            orders,
            [
                {
                    "type": "attack_fire",
                    "unit_id": "U1",
                    "fire_id": "F1",
                    "tactic": "direct",
                    "reason": "test",
                }
            ],
        )

    def test_attack_rejects_unknown_fires_blocked_tactics_and_out_fires(self):
        cases = (
            ("F9", "direct", "Unknown"),
            ("F2", "direct", "crowning"),
            ("F3", "flank", "out"),
            ("F1", "backfire", "Invalid tactic"),
        )
        for fire_id, tactic, why in cases:
            orders, rejected, _ = validate_orders(
                {
                    "summary": "",
                    "orders": [
                        order(type="attack_fire", unit_id="U1", fire_id=fire_id, tactic=tactic)
                    ],
                },
                self.index,
            )
            self.assertEqual(orders, [], fire_id)
            self.assertIn(why, rejected[0]["reason"])

    def test_a_fire_too_hot_for_direct_attack_can_still_be_flanked(self):
        orders, rejected, _ = validate_orders(
            {
                "summary": "",
                "orders": [order(type="attack_fire", unit_id="U1", fire_id="F2", tactic="flank")],
            },
            self.index,
        )
        self.assertEqual(rejected, [])
        self.assertEqual(orders[0]["tactic"], "flank")

    def test_one_order_per_unit(self):
        orders, rejected, _ = validate_orders(
            {
                "summary": "",
                "orders": [
                    order(type="attack_fire", unit_id="U1", fire_id="F1"),
                    order(type="recall_unit", unit_id="U1"),
                ],
            },
            self.index,
        )
        self.assertEqual(len(orders), 1)
        self.assertIn("Duplicate", rejected[0]["reason"])
