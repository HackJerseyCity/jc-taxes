import importlib
import json
from hashlib import md5

import pytest
from click import echo
from botocore.exceptions import ClientError
from click.testing import CliRunner

module = importlib.import_module("jc_taxes.r2")


class Objects:
    def __init__(self, objects):
        self.objects = objects
        self.writes = []

    def download_file(self, bucket, key, path):
        from pathlib import Path
        Path(path).write_bytes(self.objects[bucket, key])

    def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Bucket, Key])}

    def put_object(self, Bucket, Key, Body, IfNoneMatch):
        assert IfNoneMatch == "*"
        assert (Bucket, Key) not in self.objects
        content = Body.read()
        self.writes.append((Bucket, Key, content))
        self.objects[Bucket, Key] = content


@pytest.mark.parametrize("mode", ["publish", "dry", "existing", "corrupt-source", "corrupt-destination"])
def test_promote(tmp_path, monkeypatch, mode):
    oid = md5(b"data").hexdigest()
    key = f"{module.CACHE_PREFIX}/{oid[:2]}/{oid[2:]}"
    sidecar = tmp_path / "data.dvc"
    sidecar.write_text(json.dumps({"outs": [{"hash": "md5", "md5": oid, "size": 4, "path": "data"}]}) + "\n")
    source = b"bad" if mode == "corrupt-source" else b"data"
    objects = {("staging", key): source}
    if mode == "existing":
        objects[module.R2_BUCKET, key] = b"data"
    elif mode == "corrupt-destination":
        objects[module.R2_BUCKET, key] = b"bad"
    before = dict(objects)
    client = Objects(objects)
    monkeypatch.setattr(module, "_client", lambda: client)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "err", lambda message: echo(message, err=True))
    args = ["promote", "-s", "staging", str(sidecar)]
    if mode == "dry":
        args.append("-n")
    result = CliRunner().invoke(module.r2, args)
    if mode.startswith("corrupt"):
        bucket = "staging" if mode == "corrupt-source" else module.R2_BUCKET
        assert result.exit_code == 1
        assert result.output == f"Error: {bucket}/{key}: hash or size mismatch\n"
    else:
        assert result.exit_code == 0, result.output
        expected = {
            "publish": f"promoted verified {oid} (4 B)\n",
            "dry": f"would promote verified {oid} (4 B)\n",
            "existing": f"skip verified canonical {oid}\n",
        }
        assert result.output == expected[mode]
    assert client.writes == ([(module.R2_BUCKET, key, b"data")] if mode == "publish" else [])
    assert client.objects == (before | {(module.R2_BUCKET, key): b"data"} if mode == "publish" else before)


@pytest.mark.parametrize("raced_content", [b"data", b"bad"])
def test_promote_conditional_creation_race(tmp_path, monkeypatch, raced_content):
    oid = md5(b"data").hexdigest()
    key = f"{module.CACHE_PREFIX}/{oid[:2]}/{oid[2:]}"
    sidecar = tmp_path / "data.dvc"
    sidecar.write_text(json.dumps({"outs": [{"hash": "md5", "md5": oid, "size": 4, "path": "data"}]}) + "\n")
    client = Objects({("staging", key): b"data"})

    def race(**kwargs):
        assert kwargs["IfNoneMatch"] == "*"
        client.objects[module.R2_BUCKET, key] = raced_content
        raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")

    monkeypatch.setattr(client, "put_object", race)
    monkeypatch.setattr(module, "_client", lambda: client)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "err", lambda message: echo(message, err=True))
    result = CliRunner().invoke(module.r2, ["promote", "-s", "staging", str(sidecar)])
    if raced_content == b"data":
        assert (result.exit_code, result.output) == (0, f"promoted verified {oid} (4 B)\n")
    else:
        assert (result.exit_code, result.output) == (1, f"Error: {module.R2_BUCKET}/{key}: hash or size mismatch\n")
    assert client.writes == []
    assert client.objects == {("staging", key): b"data", (module.R2_BUCKET, key): raced_content}
