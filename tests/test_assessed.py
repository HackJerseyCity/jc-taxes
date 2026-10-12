import pandas as pd
import pytest

from jc_taxes.assessed import annotate, is_taxable, load, norm_part, unit_key


def test_norm_part():
    assert norm_part("00012") == "12"
    assert norm_part("00001  01") == "1.01"
    assert norm_part("00001 001") == "1.001"
    assert norm_part("07301  01") == "7301.01"
    assert norm_part("00000") == "0"
    assert unit_key("07301  01", "00044  02", "C0002 ") == "7301.01-44.02-C0002"
    assert unit_key("00101", "00006", "HM") == "101-6-HM"


def test_is_taxable():
    assert is_taxable("2") and is_taxable("4A") and not is_taxable("15F") and not is_taxable("15c")


@pytest.fixture
def records(tmp_path):
    rows = [
        # county_district, block, lot, qualifier, class, net, improvement, land, year
        ("0906", "00010", "00001  01", "", "4A", 1_000_000, 800_000, 200_000, "2022"),
        ("0906", "00010", "00002", "C0001", "2", 300_000, 250_000, 50_000, ""),
        ("0906", "00010", "00002", "C0002", "2", 400_000, 350_000, 50_000, "2019"),
        ("0906", "00010", "00002", "C0003", "15F", 900_000, 800_000, 100_000, "2021"),
        ("0906", "00010", "00003", "", "15C", 50_000, 0, 50_000, ""),
        ("0901", "00010", "00001  01", "", "2", 7, 7, 0, "1999"),  # another town: ignored
    ]
    cols = ["county_district", "block", "lot", "qualifier", "property_class",
            "net_value", "improvement_value", "land_value", "year_constructed"]
    p = tmp_path / "2026.parquet"
    pd.DataFrame(rows, columns=cols).to_parquet(p)
    return load(p)


def feat(block, lot, qual=None, **pr):
    return {"type": "Feature", "geometry": None, "properties": {"block": block, "lot": lot, **({"qual": qual} if qual is not None else {}), **pr}}


def test_annotate_units(records):
    fs = [
        feat("10", "1.01", ""),
        feat("10", "2", "C0001", yr_built=1990),
        feat("10", "2", "C0002"),
        feat("10", "2", "C0003"),
        feat("10", "9", ""),  # no MOD-IV record
    ]
    st = annotate("unit", fs, records)
    assert st == {"features": 5, "matched": 4, "yr_filled": 3}
    pr = [f["properties"] for f in fs]
    assert pr[0]["av"] == 1_000_000 and "av_x" not in pr[0] and pr[0]["yr_built"] == 2022
    assert pr[1]["av"] == 300_000 and pr[1]["yr_built"] == 1990  # existing year kept
    assert pr[2]["yr_built"] == 2019
    assert pr[3]["av_x"] == 900_000 and "av" not in pr[3] and pr[3]["yr_built"] == 2021
    assert "av" not in pr[4] and "yr_built" not in pr[4]


def test_annotate_lots_sum_units(records):
    fs = [feat("10", "1.01"), feat("10", "2"), feat("10", "3")]
    st = annotate("lot", fs, records)
    assert st["matched"] == 3
    a, b, c = (f["properties"] for f in fs)
    assert a == {"block": "10", "lot": "1.01", "av": 1_000_000, "yr_built": 2022}
    # Condo lot: taxable units summed, the 15F unit apart; no base record → earliest unit year.
    assert b == {"block": "10", "lot": "2", "av": 700_000, "av_x": 900_000, "yr_built": 2019}
    assert c == {"block": "10", "lot": "3", "av_x": 50_000}
