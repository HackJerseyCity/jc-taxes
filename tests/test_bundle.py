import struct

from jc_taxes.bundle import build, encode_values, keyed, round_coords, run_length, small_values, ward_shapes, year_values


def feat(block, lot, paid, billed, owner, qual=None, area=100.0):
    pr = {"block": block, "lot": lot, "paid": paid, "billed": billed, "paid_per_sqft": paid / area, "year": 0, "area_sqft": area, "owner": owner, "addr": f"{lot} Main St"}
    if qual:
        pr["qual"] = qual
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 0]]]}, "properties": pr}


def test_build_aligns_years_by_id():
    per_year = {
        2025: [feat("1", "2", 100.5, 100.5, "A"), feat("1", "3", 10.0, 12.0, "B")],
        # Latest year lists features in a different order, with an owner change.
        2026: [feat("1", "3", 11.0, 13.0, "B"), feat("1", "2", 0.0, 200.25, "C")],
    }
    geom, values, details = build("lot", per_year)
    # Details (address, owner history, …) move to D1; geometry keeps what every parcel needs.
    assert [f["properties"] for f in geom["features"]] == [
        {"block": "1", "lot": "3", "area_sqft": 100.0},
        {"block": "1", "lot": "2", "area_sqft": 100.0},
    ]
    assert values == {
        "years": [2025, 2026],
        "count": 2,
        "paid": [[1000, 10050], [1100, 0]],
        "billed_minus_paid": [[200, 0], [200, 20025]],
    }
    blank = {"bldg_desc": None, "stories": None, "units": None, "bldg_sqft": None, "lng": 0, "lat": 0}
    assert details == {
        "1-3": {"addr": "3 Main St", **blank, "owners": [[2025, "B"]]},
        "1-2": {"addr": "2 Main St", **blank, "owners": [[2025, "A"], [2026, "C"]]},
    }


def test_run_length():
    assert run_length({2015: "A", 2016: "A", 2017: "B", 2018: "A"}) == [[2015, "A"], [2017, "B"], [2018, "A"]]
    assert run_length({2015: None, 2016: None}) == []


def test_encode_values_layout():
    values = {"years": [2025, 2026], "count": 2, "paid": [[1000, 10050], [1100, 0]], "billed_minus_paid": [[200, 0], [200, 20025]]}
    b = encode_values(values)
    assert b[:4] == b"JCTV"
    assert struct.unpack("<5I", b[4:24]) == (1, 1, 2025, 2, 2)
    # [feature][year]: feature 0 = (1000, 1100), feature 1 = (10050, 0); then billed − paid.
    assert struct.unpack("<8i", b[24:]) == (1000, 1100, 10050, 0, 200, 200, 0, 20025)


def test_encode_values_overflow_uses_f64():
    big = 3_000_000_000  # $30M in cents: over i32
    b = encode_values({"years": [2025], "count": 1, "paid": [[big]], "billed_minus_paid": [[0]]})
    assert struct.unpack("<5I", b[4:24]) == (1, 2, 2025, 1, 1)
    assert struct.unpack("<2d", b[24:]) == (float(big), 0.0)


def test_round_coords():
    assert round_coords([[[-74.05539630685645, 40.762894620061346]]]) == [[[-74.055396, 40.762895]]]


def test_year_values():
    values = {"years": [2025, 2026], "count": 2, "paid": [[1000, 10050], [1100, 0]], "billed_minus_paid": [[200, 0], [200, 20025]]}
    assert year_values(values, 2026) == {"years": [2026], "count": 2, "paid": [[1100, 0]], "billed_minus_paid": [[200, 20025]]}


def ward(w, paid, area, lots_shape):
    pr = {"ward": w, "population": 1000, "paid": paid, "billed": paid, "area_sqft": area, "paid_per_sqft": paid / area, "year": 0, "lots": lots_shape, "blocks": None, "boundary": {"b": w}}
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 0]]]}, "properties": pr}


def test_small_view_values_and_shapes():
    per_year = {2025: [ward("A", 10.0, 100.0, {"l": 1}), ward("B", 20.0, 200.0, None)], 2026: [ward("B", 22.0, 210.0, None), ward("A", 11.0, 101.0, {"l": 2})]}
    geom, _, details = build("ward", per_year)
    # Latest year's order; area and alternate shapes leave the geometry file.
    assert [f["properties"] for f in geom["features"]] == [
        {"ward": "B", "population": 1000, "boundary": {"b": "B"}},
        {"ward": "A", "population": 1000, "boundary": {"b": "A"}},
    ]
    assert details == {}
    assert small_values("ward", per_year, keyed(per_year[2026])) == {
        2025: {"count": 2, "paid": [20.0, 10.0], "billed": [20.0, 10.0], "area_sqft": [200.0, 100.0]},
        2026: {"count": 2, "paid": [22.0, 11.0], "billed": [22.0, 11.0], "area_sqft": [210.0, 101.0]},
    }
    assert ward_shapes(per_year[2026]) == {"B": {}, "A": {"lots": {"l": 2}}}
