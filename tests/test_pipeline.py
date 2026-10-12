from collections import Counter

from jc_taxes.d1 import portfolios_sql
from jc_taxes.pipeline import stages


def test_portfolios_sql():
    sql = portfolios_sql([
        {"key": "a", "label": "A's Co", "blocks": ["1", "2"], "keywords": []},
        {"key": "b", "label": "B", "note": "n", "parcels": ["3-4"]},
    ])
    upsert = (
        "ON CONFLICT(key) DO UPDATE SET label=excluded.label, note=excluded.note, blocks=excluded.blocks, "
        "parcels=excluded.parcels, keywords=excluded.keywords, ord=excluded.ord, updated_at=excluded.updated_at;"
    )
    insert = "INSERT INTO portfolios (key, label, note, blocks, parcels, keywords, ord, updated_at) VALUES "
    assert sql.split("\n") == [
        insert + """('a', 'A''s Co', NULL, '["1","2"]', NULL, NULL, 0, datetime('now')) """ + upsert,
        insert + """('b', 'B', 'n', NULL, '["3-4"]', NULL, 1, datetime('now')) """ + upsert,
        "DELETE FROM portfolios WHERE key NOT IN ('a', 'b');",
        "",
    ]


def test_stages():
    arts = stages()
    paths = [a.path for a in arts]
    assert len(paths) == len(set(paths))
    # 12 years × 5 views of GeoJSON; bundle: 5 geom + 12 × (3 binary views
    # + 2 small views + ward shapes) + parcels SQL.
    assert Counter(a.computation.cmd.split(" -y ")[0] for a in arts) == {
        "python -m jc_taxes.cli hls pack": 1,
        "python -m jc_taxes.payments": 1,
        "python -m jc_taxes.cli parcels combine -c parcels/Hudson_County_Parcels_April_2026.geojson": 1,
        "python -m jc_taxes.geojson_yearly": 60,
        "python -m jc_taxes.cli bundle -n": 5 + 12 * 6 + 1,
        "python -m jc_taxes.cli aggregates -n": 1,
        "python -m jc_taxes.cli d1 portfolios": 1,
        "python -m jc_taxes.cli r2 precompress": 1,
        "python -m jc_taxes.cli d1 load -d jct-dev": 1,
        "python -m jc_taxes.cli d1 load -d jct": 1,
    }
    # Upstream first: every Artifact dep that's a stage precedes its dependent.
    index = {p: i for i, p in enumerate(paths)}
    for i, a in enumerate(arts):
        for d in a.computation.deps:
            assert index.get(d.path, -1) < i, (a.path, d.path)


def test_hls_pack_roundtrip(tmp_path):
    import gzip
    import json

    from jc_taxes.hls import iter_records, pack

    src = tmp_path / "cache"
    src.mkdir()
    # Written out of order, with non-compact formatting.
    for acct in ("300", "100", "200"):
        with gzip.open(src / f"{acct}.json.gz", "wt") as f:
            json.dump({"accountInquiryVM": {"AccountNumber": int(acct), "Owner": "É"}}, f, indent=2)
    out = tmp_path / "hls.parquet"
    assert pack(src, out) == 3
    assert list(iter_records(out)) == [
        {"accountInquiryVM": {"AccountNumber": 100, "Owner": "É"}},
        {"accountInquiryVM": {"AccountNumber": 200, "Owner": "É"}},
        {"accountInquiryVM": {"AccountNumber": 300, "Owner": "É"}},
    ]


def test_geom_depends_on_modiv():
    from jc_taxes.pipeline import MODIV
    deps = {a.path: {d.path for d in a.computation.deps} for a in stages()}
    assert MODIV in deps["www/public/geom-lots.geojson"]
    assert MODIV in deps["www/public/geom-units.geojson"]
    assert MODIV not in deps["www/public/geom-blocks.geojson"]
