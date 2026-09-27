import pandas as pd

from jc_taxes.geojson_yearly import drop_condo_diagrams


def test_drop_condo_diagrams():
    parcels = pd.DataFrame([
        {"block": "1", "lot": "1.01", "qual": None},     # lot polygon
        {"block": "1", "lot": "1.01", "qual": "C0001"},  # its unit diagrams → dropped
        {"block": "1", "lot": "1.01", "qual": "C0002"},
        {"block": "2", "lot": "5", "qual": "C0001"},     # units only, no lot polygon → kept
        {"block": "2", "lot": "5", "qual": "C0002"},
        {"block": "3", "lot": "7", "qual": ""},          # plain lot → kept
    ])
    out = drop_condo_diagrams(parcels).fillna({"qual": ""})
    assert out.to_dict("records") == [
        {"block": "1", "lot": "1.01", "qual": ""},
        {"block": "2", "lot": "5", "qual": "C0001"},
        {"block": "2", "lot": "5", "qual": "C0002"},
        {"block": "3", "lot": "7", "qual": ""},
    ]
