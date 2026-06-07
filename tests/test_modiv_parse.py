"""Tests for the fixed-width MOD-IV record parser (`jc_taxes.modiv`)."""
from jc_taxes.modiv import _decode_tax, _decode_int, _decode_acre, parse_record


def test_decode_tax_zoned_positive_zero():
    # `00000000{` — zoned decimal, `{` overpunch = positive 0 (current_year_tax)
    assert _decode_tax("00000000{") == 0.0


def test_decode_tax_zoned_positive_digits():
    # last byte `A` = +1 → 00012345 + 1 = 000123451 cents = $1234.51
    assert _decode_tax("00012345A") == 1234.51


def test_decode_tax_zoned_negative():
    # last byte `J` = -1 → 00012345 + 1 = 000123451 cents, negated
    assert _decode_tax("00012345J") == -1234.51


def test_decode_tax_left_justified_ascii():
    # Real last_year_tax form: left-justified ASCII, right-space-padded
    assert _decode_tax("9300450  ") == 93004.50
    assert _decode_tax("0        ") == 0.0


def test_decode_tax_blank_is_none():
    assert _decode_tax("         ") is None
    assert _decode_tax("") is None


def test_decode_int_and_acre():
    assert _decode_int("17730000 ") == 17730000
    assert _decode_int("         ") is None
    # 9(5)V9(4): 000394080 → 39.4080 acres (matches "39.408 ACRES" land desc)
    assert _decode_acre("000394080") == 39.408
    assert _decode_acre("000000000") == 0.0


def test_parse_record_key_fields():
    # First JC record from 2025/HudsonRE.txt, padded to 700 chars.
    line = (
        "090600101    00001  01         HM20"
        "00122724673700655780 4B1075 SECAUCUS RD.        "
        "PROP.1S-IN-W-P 39.408 ACRES        000394080"
    ).ljust(700)
    rec = parse_record(line)
    assert rec["county_district"] == "0906"
    assert rec["block"] == "00101"
    assert rec["qualifier"] == "HM"
    assert rec["record_id"] == "20"
    assert rec["property_class"] == "4B"
    assert rec["property_location"] == "1075 SECAUCUS RD."
    assert rec["building_description"] == "PROP.1S-IN-W-P"
    assert rec["calculated_acreage"] == 39.408
