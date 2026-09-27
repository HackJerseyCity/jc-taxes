from jc_taxes.aggregates import portfolio_predicate, prop_equals, view_rows


def feat(**pr):
    return {"properties": pr}


FEATS = [
    feat(block="100", lot="1", ward="A", hood="X", area_sqft=1000, paid=500.0, billed=600.0, paid_per_sqft=0.5, billed_per_sqft=0.6),
    feat(block="100", lot="2", ward="A", hood="X", area_sqft=100, paid=900.0, billed=900.0, paid_per_sqft=9.0, billed_per_sqft=9.0),
    feat(block="200", lot="1", ward="B", area_sqft=2000, paid=100.0, billed=300.0, paid_per_sqft=0.05, billed_per_sqft=0.15),
    feat(block="300", lot="5", qual="C0001", ward="B", area_sqft=800, paid=50.0, billed=50.0, paid_per_sqft=0.0625, billed_per_sqft=0.0625),
]
PF = {"key": "dev", "parcels": ["100-1", "300-5-C0001"]}


def test_view_rows_paid_year():
    focuses = {
        "": None,
        "pf:dev": portfolio_predicate(PF, block_granular=False),
        "ward:A": prop_equals("ward", "A"),
        "hood:X": prop_equals("hood", "X"),
        "ward:C": prop_equals("ward", "C"),
    }
    assert view_rows("unit", 2025, FEATS, focuses) == [
        # Lot 100-2 (100 sqft) is a sliver: counted and totalled, but not in the per-sqft max.
        ("unit", "", 2025, 4, 1550.0, 1550.0, 1850.0, 0.5, 900.0, None),
        ("unit", "pf:dev", 2025, 2, 550.0, 550.0, 650.0, 0.5, 500.0, None),
        ("unit", "ward:A", 2025, 2, 1400.0, 1400.0, 1500.0, 0.5, 900.0, None),
        ("unit", "hood:X", 2025, 2, 1400.0, 1400.0, 1500.0, 0.5, 900.0, None),
        # ward:C has no members → no row.
    ]


def test_view_rows_billed_year():
    assert view_rows("unit", 2026, FEATS, {"": None}) == [
        ("unit", "", 2026, 4, 1850.0, 1550.0, 1850.0, 0.6, 900.0, None),
    ]


def test_portfolio_predicate_granularity():
    lot = portfolio_predicate(PF, block_granular=False)
    block = portfolio_predicate(PF, block_granular=True)
    assert [lot(f["properties"]) for f in FEATS] == [True, False, False, True]
    # Block views credit any block holding a member parcel.
    assert [block(f["properties"]) for f in FEATS] == [True, True, False, True]
    # A unit entry doesn't match the unit-less lot feature.
    assert lot({"block": "300", "lot": "5"}) is False
