"""Extract Everbridge launch-area polygons from Boulder County's Marshall Fire GeoPDF.

The county map (``Rachel-Map-1.pdf``, ArcGIS Pro 2.8 export) stores each launch
area as an optional-content layer named e.g. ``Marshall Fire 2A - Evacuation
Order: 12/30/2021 (12:15 PM)`` and carries a GeoPDF ``/Measure`` dictionary
(``/GPTS`` + ``/LPTS``, NAD83 HARN Colorado North State Plane, US feet).

Method (stdlib only, deterministic):
1. Decode object streams and the page's form XObjects; interpret the content
   stream operators that matter for geometry (q/Q, cm, m/l/c/h/re, paint
   operators, BDC/EMC, Do) while tracking the CTM and optional-content stack.
2. Keep filled paths painted inside a zone layer that lies under the map frame
   (legend patches are excluded).
3. Fit an affine map from viewport-unit coordinates (LPTS) to State Plane
   metres, using the forward Lambert conformal conic projection of the four
   GPTS corners, then invert the projection for every vertex. NAD83 HARN
   latitude/longitude is used as OGC:CRS84 (sub-metre datum difference).
The result is a ``derived`` digitization of an observed official map.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import zlib
from pathlib import Path


class GeoPdfError(ValueError):
    pass


# ----------------------------------------------------------------- PDF objects

def load_objects(data: bytes) -> dict[int, bytes]:
    objects: dict[int, bytes] = {}
    for match in re.finditer(rb"(?<![0-9])(\d+) 0 obj", data):
        end = data.find(b"endobj", match.end())
        objects[int(match.group(1))] = data[match.end():end]
    for body in list(objects.values()):
        header = body[:body.find(b"stream")] if b"stream" in body else body
        if not re.search(rb"/Type ?/ObjStm", header):
            continue
        count = int(re.search(rb"/N (\d+)", header).group(1))
        first = int(re.search(rb"/First (\d+)", header).group(1))
        content = stream_bytes(body)
        numbers = list(map(int, content[:first].split()))
        for index in range(count):
            number, offset = numbers[2 * index], numbers[2 * index + 1]
            end = numbers[2 * index + 3] if index + 1 < count else len(content) - first
            objects[number] = content[first + offset:first + end]
    return objects


def stream_bytes(body: bytes) -> bytes:
    start = body.find(b"stream") + 6
    start += 2 if body[start:start + 2] == b"\r\n" else 1
    raw = body[start:body.rfind(b"endstream")]
    return zlib.decompress(raw) if b"/FlateDecode" in body[:start] else raw


def name_map(body: bytes, key: bytes) -> dict[str, int]:
    """Read ``/Key << /Name n 0 R ... >>`` (inline) or ``/Key n 0 R`` (indirect)."""
    match = re.search(re.escape(key) + rb"\s*<<(.*?)>>", body, re.S)
    if not match:
        return {}
    return {m.group(1).decode(): int(m.group(2))
            for m in re.finditer(rb"/([\w.\-]+)\s+(\d+) 0 R", match.group(1))}


def resolve_dict(objects: dict[int, bytes], body: bytes, key: bytes) -> dict[str, int]:
    indirect = re.search(re.escape(key) + rb"\s+(\d+) 0 R", body)
    if indirect:
        return name_map(b"/X" + objects[int(indirect.group(1))], b"/X")
    return name_map(body, key)


def ocg_name(objects: dict[int, bytes], number: int) -> str:
    body = objects[number]
    match = re.search(rb"/Name ?\((.*?)(?<!\\)\)", body, re.S)
    if not match:
        return ""
    raw = match.group(1).replace(b"\\(", b"(").replace(b"\\)", b")")
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", errors="replace")
    return raw.decode("latin-1")


# ----------------------------------------------------------- content parsing

TOKEN = re.compile(rb"/[^\s/\[\]()<>{}%]+|\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|<<|>>|\[|\]|[^\s/\[\]()<>{}%]+")
NUMBER = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)")


def multiply(a: list[float], b: list[float]) -> list[float]:
    return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
            a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
            a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]]


def apply(m: list[float], x: float, y: float) -> tuple[float, float]:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def walk(objects: dict[int, bytes], form: int, ctm: list[float], oc_stack: list[str],
         resources: bytes, out: list[dict]) -> None:
    content = stream_bytes(objects[form])
    props = resolve_dict(objects, resources, b"/Properties")
    xobjects = resolve_dict(objects, resources, b"/XObject")
    stack: list[list[float]] = []
    marked: list[str | None] = []
    operands: list[bytes] = []
    subpaths: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    for token in TOKEN.findall(content):
        if NUMBER.fullmatch(token) or token[:1] in (b"/", b"(", b"<", b"[", b"]") or token == b">>":
            operands.append(token)
            continue
        op = token
        nums = [float(t) for t in operands if NUMBER.fullmatch(t)]
        if op == b"q":
            stack.append(ctm[:])
        elif op == b"Q":
            ctm = stack.pop()
        elif op == b"cm":
            ctm = multiply(nums[-6:], ctm)
        elif op == b"m":
            if current:
                subpaths.append(current)
            current = [apply(ctm, nums[-2], nums[-1])]
        elif op == b"l":
            current.append(apply(ctm, nums[-2], nums[-1]))
        elif op in (b"c", b"v", b"y"):
            current.append(apply(ctm, nums[-2], nums[-1]))
        elif op == b"h":
            if current:
                subpaths.append(current)
            current = []
        elif op == b"re":
            x, y, w, h = nums[-4:]
            if current:
                subpaths.append(current)
            subpaths.append([apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)])
            current = []
        elif op in (b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"S", b"s", b"n"):
            if current:
                subpaths.append(current)
            if op != b"n" and subpaths:
                out.append({"op": op.decode(), "layers": [n for n in oc_stack + [m for m in marked if m]],
                            "rings": subpaths})
            subpaths, current = [], []
        elif op == b"BDC":
            names = [t.decode()[1:] for t in operands if t.startswith(b"/")]
            if len(names) >= 2 and names[0] == "OC" and names[1] in props:
                marked.append(ocg_name(objects, props[names[1]]))
            else:
                marked.append(None)
        elif op == b"BMC":
            marked.append(None)
        elif op == b"EMC":
            if marked:
                marked.pop()
        elif op == b"Do":
            name = operands[-1].decode()[1:]
            number = xobjects.get(name)
            if number is not None and b"/Subtype /Form" in objects[number][:400] or (
                    number is not None and b"/Subtype/Form" in objects[number][:400]):
                header = objects[number][:objects[number].find(b"stream")]
                matrix = re.search(rb"/Matrix ?\[([^\]]*)\]", header)
                form_ctm = multiply([float(v) for v in matrix.group(1).split()], ctm) if matrix else ctm[:]
                res = re.search(rb"/Resources (\d+) 0 R", header)
                walk(objects, number, form_ctm, oc_stack + [m for m in marked if m],
                     objects[int(res.group(1))] if res else header, out)
        operands = []


# ------------------------------------------------------------- projection

GRS80_A = 6378137.0
GRS80_F = 1 / 298.257222101
US_FOOT_M = 0.3048006096012192


class LambertConic:
    """EPSG Lambert Conic Conformal (2SP), ellipsoidal, output metres."""

    def __init__(self, lat1: float, lat2: float, lat0: float, lon0: float, fe_m: float, fn_m: float) -> None:
        self.e = math.sqrt(GRS80_F * (2 - GRS80_F))
        phi1, phi2, phi0 = map(math.radians, (lat1, lat2, lat0))
        m1, m2 = self._m(phi1), self._m(phi2)
        t1, t2, t0 = self._t(phi1), self._t(phi2), self._t(phi0)
        self.n = (math.log(m1) - math.log(m2)) / (math.log(t1) - math.log(t2))
        self.F = m1 / (self.n * t1 ** self.n)
        self.r0 = GRS80_A * self.F * t0 ** self.n
        self.lon0, self.fe, self.fn = math.radians(lon0), fe_m, fn_m

    def _m(self, phi: float) -> float:
        return math.cos(phi) / math.sqrt(1 - (self.e * math.sin(phi)) ** 2)

    def _t(self, phi: float) -> float:
        es = self.e * math.sin(phi)
        return math.tan(math.pi / 4 - phi / 2) / ((1 - es) / (1 + es)) ** (self.e / 2)

    def forward(self, lon: float, lat: float) -> tuple[float, float]:
        r = GRS80_A * self.F * self._t(math.radians(lat)) ** self.n
        theta = self.n * (math.radians(lon) - self.lon0)
        return self.fe + r * math.sin(theta), self.fn + self.r0 - r * math.cos(theta)

    def inverse(self, x: float, y: float) -> tuple[float, float]:
        dx, dy = x - self.fe, self.r0 - (y - self.fn)
        r = math.copysign(math.hypot(dx, dy), self.n)
        t = (r / (GRS80_A * self.F)) ** (1 / self.n)
        theta = math.atan2(dx, dy)
        phi = math.pi / 2 - 2 * math.atan(t)
        for _ in range(15):
            es = self.e * math.sin(phi)
            phi = math.pi / 2 - 2 * math.atan(t * ((1 - es) / (1 + es)) ** (self.e / 2))
        return math.degrees(theta / self.n + self.lon0), math.degrees(phi)


def parse_measure(objects: dict[int, bytes]) -> tuple[list[float], list[tuple[float, float]], list[tuple[float, float]], LambertConic]:
    for body in objects.values():
        if b"/GPTS" in body and b"/Viewport" in body:
            bbox = [float(v) for v in re.search(rb"/BBox \[([^\]]*)\]", body).group(1).split()]
            gpts = [float(v) for v in re.search(rb"/GPTS \[([^\]]*)\]", body).group(1).split()]
            lpts = [float(v) for v in re.search(rb"/LPTS \[([^\]]*)\]", body).group(1).split()]
            wkt = re.search(rb"/WKT \((.*?)\)>>", body, re.S).group(1).decode()
            break
    else:
        raise GeoPdfError("no GeoPDF viewport measure found")
    if "Lambert_Conformal_Conic" not in wkt or "Foot_US" not in wkt:
        raise GeoPdfError("unexpected projection in GeoPDF")
    param = {k: float(v) for k, v in re.findall(r'PARAMETER\["(\w+)",([-0-9.]+)\]', wkt)}
    projection = LambertConic(param["Standard_Parallel_1"], param["Standard_Parallel_2"],
                              param["Latitude_Of_Origin"], param["Central_Meridian"],
                              param["False_Easting"] * US_FOOT_M, param["False_Northing"] * US_FOOT_M)
    geo = [(gpts[i + 1], gpts[i]) for i in range(0, len(gpts), 2)]  # (lon, lat)
    unit = [(lpts[i], lpts[i + 1]) for i in range(0, len(lpts), 2)]
    return bbox, unit, geo, projection


def fit_affine(src: list[tuple[float, float]], dst: list[tuple[float, float]]) -> tuple[list[float], float]:
    """Least-squares x' = a x + b y + c (same for y'); returns coefficients and max residual."""
    def solve(values: list[float]) -> list[float]:
        rows = [[x, y, 1.0] for x, y in src]
        ata = [[sum(r[i] * r[j] for r in rows) for j in range(3)] for i in range(3)]
        atb = [sum(r[i] * v for r, v in zip(rows, values)) for i in range(3)]
        for col in range(3):
            pivot = max(range(col, 3), key=lambda r: abs(ata[r][col]))
            ata[col], ata[pivot] = ata[pivot], ata[col]
            atb[col], atb[pivot] = atb[pivot], atb[col]
            for r in range(3):
                if r != col:
                    factor = ata[r][col] / ata[col][col]
                    ata[r] = [a - factor * b for a, b in zip(ata[r], ata[col])]
                    atb[r] -= factor * atb[col]
        return [atb[i] / ata[i][i] for i in range(3)]
    cx, cy = solve([p[0] for p in dst]), solve([p[1] for p in dst])
    residual = max(math.hypot(cx[0] * x + cx[1] * y + cx[2] - u, cy[0] * x + cy[1] * y + cy[2] - v)
                   for (x, y), (u, v) in zip(src, dst))
    return cx + cy, residual


# ------------------------------------------------------------------ extraction

ZONE = re.compile(r"Marshall Fire (\d)([AB]?)\s+- (Evacuation Order|Evacuation Warning): 12/30/2021 \((\d{1,2}:\d{2} [AP]M)\)")


def signed_area(ring: list[tuple[float, float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def extract(pdf: bytes) -> dict:
    objects = load_objects(pdf)
    page = next(n for n, b in objects.items() if re.search(rb"/Type ?/Page[^s]", b) and b"/VP" in b)
    page_body = objects[page]
    contents = int(re.search(rb"/Contents (\d+) 0 R", page_body).group(1))
    resources = objects[int(re.search(rb"/Resources (\d+) 0 R", page_body).group(1))]
    paths: list[dict] = []
    walk(objects, contents, [1, 0, 0, 1, 0, 0], [], resources, paths)
    bbox, unit, geo, projection = parse_measure(objects)
    state_plane = [projection.forward(lon, lat) for lon, lat in geo]
    affine, residual_m = fit_affine(unit, state_plane)
    x0, y0, x1, y1 = bbox

    def to_lonlat(point: tuple[float, float]) -> list[float]:
        u, v = (point[0] - x0) / (x1 - x0), (point[1] - y0) / (y1 - y0)
        x = affine[0] * u + affine[1] * v + affine[2]
        y = affine[3] * u + affine[4] * v + affine[5]
        lon, lat = projection.inverse(x, y)
        return [round(lon, 7), round(lat, 7)]

    zones: dict[str, dict] = {}
    for path in paths:
        if path["op"] not in ("f", "f*", "B", "B*", "b", "b*"):
            continue
        if "Legend" in path["layers"] or "Map Frame" not in path["layers"]:
            continue
        match = next((ZONE.fullmatch(n) for n in path["layers"] if ZONE.fullmatch(n)), None)
        if not match:
            continue
        label = f"{match.group(1)}{match.group(2).lower()}"
        zone = zones.setdefault(label, {"layer_name": next(n for n in path["layers"] if ZONE.fullmatch(n)),
                                        "message_title": match.group(3), "map_time_local": match.group(4),
                                        "rings": []})
        for ring in path["rings"]:
            if len(ring) >= 3 and abs(signed_area(ring)) > 1.0:
                coords = [to_lonlat(p) for p in ring]
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                if coords not in zone["rings"]:
                    zone["rings"].append(coords)
    features = []
    for label in sorted(zones, key=lambda s: (int(s[0]), s[1:])):
        zone = zones[label]
        rings = sorted(zone["rings"], key=lambda r: -abs(signed_area([tuple(p) for p in r])))
        polygons = []
        for ring in rings:  # even-odd containment: a ring inside an earlier outer ring is a hole
            inside = next((poly for poly in polygons if point_in_ring(ring[0], poly[0])), None)
            oriented = ring if (signed_area([tuple(p) for p in ring]) > 0) == (inside is None) else ring[::-1]
            if inside is None:
                polygons.append([oriented])
            else:
                inside.append(oriented)
        geometry = ({"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1
                    else {"type": "MultiPolygon", "coordinates": polygons})
        features.append({"type": "Feature", "id": f"boco-everbridge-2021-marshall-{label}", "geometry": geometry,
                         "properties": {"map_label": label.upper(), "layer_name": zone["layer_name"],
                                        "message_title": zone["message_title"], "map_time_local": zone["map_time_local"],
                                        "ring_count": len(rings)}})
    return {"type": "FeatureCollection", "features": features,
            "georeference": {"viewport_bbox_pt": bbox, "gpts_lonlat": geo,
                             "projection": "NAD83 HARN / Colorado North (ftUS), Lambert conformal conic 2SP",
                             "affine_fit_max_residual_m": round(residual_m, 3),
                             "datum_note": "NAD83 HARN latitude/longitude treated as OGC:CRS84",
                             "curve_handling": "Bezier control points dropped; end points kept"}}


def point_in_ring(point: list[float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    data = args.pdf.read_bytes()
    result = extract(data)
    result["source_sha256"] = hashlib.sha256(data).hexdigest()
    result["source_bytes"] = len(data)
    args.out.write_bytes((json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode())
    for feature in result["features"]:
        print(feature["id"], feature["geometry"]["type"], feature["properties"]["ring_count"])
    print("affine residual m", result["georeference"]["affine_fit_max_residual_m"])


if __name__ == "__main__":
    main()
