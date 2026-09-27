# jc-taxes Cloudflare infra (Pulumi)

Declarative CF stack: R2 `jc-taxes` + `jct-og`, `jc-taxes` CORS, D1 `jct` + `jct-dev`, Worker custom domains (`jct.rbw.sh`, `jct-files.rbw.sh`, and `jct-dev.rbw.sh` once `dev_domain` is on). Same pattern as crashes / ctbk: Pulumi (Python), `pulumi-cloudflare`, local git-committed `state/` (passphrase-encrypted secrets; none today). Pulumi owns resources; wrangler owns Worker code (`edge/wrangler.jsonc` bindings reference the names / ids exported here). Existing resources are imported and `protect`ed. See `__main__.py` for what's deliberately unmanaged (`data.jct.rbw.sh`).

## Stack

- **`rac`**: the RAC account (`0dcad…4af63`), zone `rbw.sh`.

## Run

Auth comes from the repo's `.envrc` (`CLOUDFLARE_API_TOKEN`, `PULUMI_CONFIG_PASSPHRASE`):

```bash
cd infra
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
direnv exec .. pulumi preview --diff
direnv exec .. pulumi up
```

Dev custom domain (`jct-dev.rbw.sh` → `jct-edge-dev`; creates its DNS record):

```bash
direnv exec .. pulumi config set dev_domain true
direnv exec .. pulumi up
```

The deploy token needs Zone → Workers Routes (edit) on `rbw.sh` for the domain create.
