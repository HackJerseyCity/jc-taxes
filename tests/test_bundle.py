from jc_taxes.bundle import build, run_length


def feat(block, lot, paid, billed, owner, qual=None, area=100.0):
    pr = {"block": block, "lot": lot, "paid": paid, "billed": billed, "paid_per_sqft": paid / area, "year": 0, "area_sqft": area, "owner": owner, "addr": f"{lot} Main St"}
    if qual:
        pr["qual"] = qual
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": pr}


def test_build_aligns_years_by_id():
    per_year = {
        2025: [feat("1", "2", 100.5, 100.5, "A"), feat("1", "3", 10.0, 12.0, "B")],
        # Latest year lists features in a different order, with an owner change.
        2026: [feat("1", "3", 11.0, 13.0, "B"), feat("1", "2", 0.0, 200.25, "C")],
    }
    geom, values, owners = build("lot", per_year)
    assert [f["properties"] for f in geom["features"]] == [
        {"block": "1", "lot": "3", "area_sqft": 100.0, "addr": "3 Main St"},
        {"block": "1", "lot": "2", "area_sqft": 100.0, "addr": "2 Main St"},
    ]
    assert values == {
        "years": [2025, 2026],
        "count": 2,
        "paid": [[1000, 10050], [1100, 0]],
        "billed_minus_paid": [[200, 0], [200, 20025]],
    }
    assert owners == {"1-2": [[2025, "A"], [2026, "C"]], "1-3": [[2025, "B"]]}


def test_run_length():
    assert run_length({2015: "A", 2016: "A", 2017: "B", 2018: "A"}) == [[2015, "A"], [2017, "B"], [2018, "A"]]
    assert run_length({2015: None, 2016: None}) == []
