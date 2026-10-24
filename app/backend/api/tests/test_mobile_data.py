from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.urls import reverse
from pymongo.errors import ConnectionFailure

from api import mobile_data


class FakeResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count


class FakeCursor(list):
    def sort(self, key, direction):
        return FakeCursor(sorted(self, key=lambda doc: doc[key], reverse=direction < 0))

    def limit(self, count):
        return FakeCursor(self[:count])


class FakeCollection:
    """The handful of PyMongo calls the module makes: equality filters plus `$gt`."""

    def __init__(self):
        self.docs = []

    @staticmethod
    def _matches(doc, query):
        for key, expected in query.items():
            if isinstance(expected, dict):
                if not doc[key] > expected["$gt"]:
                    return False
            elif doc.get(key) != expected:
                return False
        return True

    def create_index(self, *args, **kwargs):
        pass

    def insert_one(self, doc):
        self.docs.append(dict(doc))

    def find_one(self, query, projection=None):
        return next((dict(d) for d in self.docs if self._matches(d, query)), None)

    def find(self, query):
        return FakeCursor(dict(d) for d in self.docs if self._matches(d, query))

    def count_documents(self, query, limit=0):
        return len([d for d in self.docs if self._matches(d, query)])

    def find_one_and_update(self, query, update, return_document=None):
        for doc in self.docs:
            if self._matches(doc, query):
                doc.update(update["$set"])
                return dict(doc)
        return None

    def delete_one(self, query):
        for doc in self.docs:
            if self._matches(doc, query):
                self.docs.remove(doc)
                return FakeResult(1)
        return FakeResult(0)


class MobileDataTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.collections = {}
        patcher = patch("api.mobile_data.get_database")
        get_database = patcher.start()
        self.addCleanup(patcher.stop)
        get_database.return_value.__getitem__.side_effect = (
            lambda name: self.collections.setdefault(name, FakeCollection())
        )

    def register(self):
        response = self.client.post(reverse("mobile-devices"), {}, content_type="application/json")
        self.assertEqual(response.status_code, 201)
        return {"HTTP_AUTHORIZATION": f"Bearer {response.json()['device_token']}"}

    def push(self, auth, data, collection="notes"):
        return self.client.post(
            reverse("mobile-collection", args=[collection]),
            {"data": data},
            content_type="application/json",
            **auth,
        )

    def test_register_stores_only_the_token_hash(self):
        response = self.client.post(reverse("mobile-devices"))
        body = response.json()
        self.assertEqual(set(body), {"device_id", "device_token"})
        stored = self.collections[mobile_data.DEVICES].docs[0]
        self.assertNotIn(body["device_token"], stored.values())
        self.assertEqual(stored["token_hash"], mobile_data._hash(body["device_token"]))
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_push_pull_update_delete_round_trip(self):
        auth = self.register()
        created = self.push(auth, {"title": "Go bag", "items": [{"name": "water", "count": 3}]})
        self.assertEqual(created.status_code, 201)
        doc = created.json()
        self.assertEqual(set(doc), {"id", "collection", "data", "created_at", "updated_at"})
        self.assertEqual(doc["collection"], "notes")

        listed = self.client.get(reverse("mobile-collection", args=["notes"]), **auth).json()
        self.assertEqual([d["id"] for d in listed["documents"]], [doc["id"]])

        url = reverse("mobile-document", args=["notes", doc["id"]])
        replaced = self.client.put(url, {"data": {"title": "Done"}}, content_type="application/json", **auth)
        self.assertEqual(replaced.json()["data"], {"title": "Done"})
        self.assertEqual(self.client.get(url, **auth).json()["data"], {"title": "Done"})

        self.assertEqual(self.client.delete(url, **auth).status_code, 204)
        self.assertEqual(self.client.get(url, **auth).status_code, 404)

    def test_devices_and_collections_are_isolated(self):
        mine, theirs = self.register(), self.register()
        doc = self.push(mine, {"secret": True}).json()
        self.assertEqual(self.client.get(reverse("mobile-collection", args=["notes"]), **theirs).json(), {"documents": []})
        self.assertEqual(self.client.get(reverse("mobile-document", args=["notes", doc["id"]]), **theirs).status_code, 404)
        self.assertEqual(self.client.get(reverse("mobile-document", args=["other", doc["id"]]), **mine).status_code, 404)
        self.assertEqual(self.client.delete(reverse("mobile-document", args=["notes", doc["id"]]), **theirs).status_code, 404)

    def test_pull_filters_by_updated_after_and_limit(self):
        auth = self.register()
        for n in range(3):
            self.push(auth, {"n": n})
        docs = self.collections[mobile_data.DOCUMENTS].docs
        base = datetime(2026, 10, 24, tzinfo=UTC)
        for n, doc in enumerate(docs):
            doc["updated_at"] = base + timedelta(minutes=n)
        url = reverse("mobile-collection", args=["notes"])
        newest = self.client.get(url, {"limit": 2}, **auth).json()["documents"]
        self.assertEqual([d["data"]["n"] for d in newest], [2, 1])
        since = self.client.get(url, {"updated_after": "2026-10-24T00:00:30Z"}, **auth).json()["documents"]
        self.assertEqual([d["data"]["n"] for d in since], [2, 1])
        self.assertEqual(self.client.get(url, {"limit": 0}, **auth).status_code, 400)
        self.assertEqual(self.client.get(url, {"updated_after": "2026-10-24T00:00:30"}, **auth).status_code, 400)

    def test_rejects_missing_or_unknown_token(self):
        url = reverse("mobile-collection", args=["notes"])
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, HTTP_AUTHORIZATION="Bearer not-a-device").status_code, 401)

    def test_rejects_bad_bodies(self):
        auth = self.register()
        url = reverse("mobile-collection", args=["notes"])
        for body in ({}, {"data": [1]}, {"data": {}, "extra": 1}):
            response = self.client.post(url, body, content_type="application/json", **auth)
            self.assertEqual(response.status_code, 400, body)
        for data in ({"$where": 1}, {"a.b": 1}, {"nested": [{"$set": 1}]}):
            self.assertEqual(self.push(auth, data).status_code, 400, data)
        self.assertEqual(self.push(auth, {"blob": "x" * (mobile_data.MAX_DATA_BYTES + 1)}).status_code, 400)
        deep = {}
        for _ in range(mobile_data.MAX_DEPTH + 2):
            deep = {"d": deep}
        self.assertEqual(self.push(auth, deep).status_code, 400)

    def test_collection_names_are_restricted_by_the_route(self):
        auth = self.register()
        for name in ("Notes", "1notes", "no-dash", "$cmd"):
            response = self.client.get(f"/api/mobile/data/{name}", **auth)
            self.assertEqual(response.status_code, 404, name)

    def test_quota_per_device(self):
        auth = self.register()
        with patch.object(mobile_data, "MAX_DOCUMENTS_PER_DEVICE", 2):
            self.push(auth, {"n": 1})
            self.push(auth, {"n": 2}, collection="other")
            self.assertEqual(self.push(auth, {"n": 3}).status_code, 409)

    def test_database_failure_is_generic_503(self):
        auth = self.register()
        with patch.object(FakeCollection, "find_one", side_effect=ConnectionFailure("private host")):
            response = self.client.get(reverse("mobile-collection", args=["notes"]), **auth)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private", response.content.decode())
