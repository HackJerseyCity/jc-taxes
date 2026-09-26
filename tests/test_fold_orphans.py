from jc_taxes.geojson_yearly import fold_orphan_payments


def amounts(pay_dict: dict) -> dict[str, float]:
    return {k: v["Paid"] for k, v in pay_dict.items()}


def test_commercial_qual_alias_folds_onto_unpaid_geometry_unit():
    # Account `C8003` has payments but no geometry; geometry `C0003` (same lot) has
    # no account → the payment lands on `C0003`, not the lot's largest unit.
    pay = {
        "9501-4.01": {"Paid": 800.0, "Billed": 800.0},
        "9501-4.01-C8003": {"Paid": 772.0, "Billed": 1709.0},
    }
    present = [
        ("9501-4.01", "9501", "4.01", 64719.0),
        ("9501-4.01-C0003", "9501", "4.01", 10621.0),
    ]
    stats = fold_orphan_payments(pay, present)
    assert stats == {"folded": 1, "folded_amt": 772.0, "dropped": 0, "dropped_amt": 0.0}
    assert amounts(pay) == {
        "9501-4.01": 800.0,
        "9501-4.01-C8003": 772.0,
        "9501-4.01-C0003": 772.0,
    }


def test_commercial_qual_alias_skipped_when_geometry_unit_has_own_payments():
    # `C0003` already has an account → no alias; fall back to the largest same-lot key.
    pay = {
        "9501-4.01": {"Paid": 800.0, "Billed": 800.0},
        "9501-4.01-C0003": {"Paid": 50.0, "Billed": 50.0},
        "9501-4.01-C8003": {"Paid": 772.0, "Billed": 772.0},
    }
    present = [
        ("9501-4.01", "9501", "4.01", 64719.0),
        ("9501-4.01-C0003", "9501", "4.01", 10621.0),
    ]
    fold_orphan_payments(pay, present)
    assert amounts(pay) == {
        "9501-4.01": 1572.0,
        "9501-4.01-C0003": 50.0,
        "9501-4.01-C8003": 772.0,
    }


def test_orphan_sub_lot_folds_onto_parent_lot():
    pay = {
        "7302-4": {"Paid": 10.0, "Billed": 10.0},
        "7302-4.01": {"Paid": 5.0, "Billed": 5.0},
    }
    present = [
        ("7302-4", "7302", "4", 1000.0),
        ("7302-9", "7302", "9", 5000.0),
    ]
    stats = fold_orphan_payments(pay, present)
    assert stats == {"folded": 1, "folded_amt": 5.0, "dropped": 0, "dropped_amt": 0.0}
    assert amounts(pay) == {"7302-4": 15.0, "7302-4.01": 5.0}
