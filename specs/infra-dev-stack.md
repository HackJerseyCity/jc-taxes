# Dev stack, IaC, versioned data, and Batch pipeline runs

## Goal

Every change (code or data) goes: build → deploy to **dev** → review it there (by hand and in Chrome) → **promote to prod**, with no ad-hoc local steps. Infrastructure is declared in code shared by both environments. Heavy pipeline stages run in AWS Batch, not on a laptop.

## Where things stand (2026-09-27)

| | status |
|---|---|
| Map data files | **Content-addressed.** The app fetches DVC objects by md5 via the Worker's `/d/files/md5/…`, and brotli copies are `br/<md5>`. Dev and prod builds coexist on the same bucket. |
| D1 (`aggregates`, `parcels`, `portfolios`) | **Separate dev / prod databases, loaded from the same DVX-tracked SQL** (`data/d1/*.sql`, `jct d1 load -d jct-dev|jct`). The prod stage's `.dvc` (`deploy/prod/d1.dvc`) records which SQL prod has. |
| OG assets | Rendered cards are content-hash keyed. Map captures (`maps/<view>-WxH.jpg`, `pnpm -C www og-maps`) are mutable keys shared by dev and prod. |
| Environments | **Done:** dev `jct-edge-dev` (+ D1 `jct-dev`) at `jct-edge-dev.ryan-0dc.workers.dev`; CI deploys dev on push, prod on manual `env: prod`. |
| IaC | **`infra/` (Pulumi) written, previewed clean; `pulumi up` pending (user).** Imports R2 `jc-taxes` / `jct-og`, D1 `jct` / `jct-dev`, Worker domains `jct.rbw.sh` / `jct-files.rbw.sh`; adopts `jc-taxes` CORS; `jct-dev.rbw.sh` behind `dev_domain`. |
| Pipeline | **DVX provenance for every stage** (`jct pipeline write`, `specs/dvx-pipeline.md`). Still runs locally. |
| Batch | **Bootstrapped in RAC AWS** (`006196295121`, us-east-1, prefix `jct`) by `batch/setup`: R2 keys in Secrets Manager (`jct/r2-*`), image in ECR `jct-pipeline:<rev>`, Fargate-Spot CE `jct-spot` (16 vCPU), queue + job def `jct` (16 vCPU / 32 GB). Run: `AWS_PROFILE=r dvx batch submit -P jct -w <targets>`. |

## Plan

### 1. Dev environment (wrangler envs)
- `wrangler.jsonc` `env.dev`: Worker `jct-edge-dev`, D1 `jct-dev`, the same `DATA` bucket (content-addressed, read-only), and OG bucket `jct-og` with a `dev/` key prefix (or its own bucket).
- Domain: **`jct-dev.rbw.sh`** (one label). `dev.jct.rbw.sh` is two labels below the zone, which needs Advanced Certificate Manager (paid) for a Workers custom domain; see the memory note in the R2 migration.
- CI: push to `main` → deploy **dev**. Promote to prod is a manual `workflow_dispatch` (or tag) that deploys the *same* commit's build to prod and runs the D1 promote.

### 2. Versioned D1 data
- Pipeline loads write to D1 tables keyed by a **data version** (the md5 of the inputs, e.g. of `jc_parcels_combined.parquet` + `payments.parquet`), or to a per-version database. The Worker reads the version its build was made with (a constant baked into the build from the same DVX lineage).
- Simpler first step: dev and prod databases (`jct-dev`, `jct`), with the promote step replaying the same SQL into prod. Cutover is then "prod Worker + prod D1 move together", with no window where one runs ahead of the other (today's regen has one).

### 3. IaC (Pulumi, following crashes / ctbk)
- `infra/` Pulumi (Python) program owning:
  - R2 buckets (`jc-taxes`, `jct-og`), imported and protected
  - `data.jct.rbw.sh` R2 custom domain + CORS
  - D1 `jct`, `jct-dev` (imported)
  - Worker custom domains (`jct.rbw.sh`, `jct-dev.rbw.sh`, `jct-files.rbw.sh`)
  - DNS records
  - the deploy token's scope (documented, not created)
- Worker scripts stay wrangler-deployed (bindings reference the Pulumi-exported names / ids), as crashes does.

### 4. Pipeline in Batch
- `batch/` Dockerfile (uv + the `jc_taxes` package + DVX), job definitions in Pulumi (AWS), secrets via SSM.
- Stages as DVX `.dvc` computations (`dvx-pipeline.md`); a Batch job runs `dvx run <target>` and pushes outputs to R2.
- Order: the HLS pull as a scheduled job (weekly); then everything downstream.
- Result: an HLS refresh or parcel refresh produces a new data version, and a dev deploy picks it up.

## Order of work

1. Dev env + `jct-dev` D1 + promote workflow (small; unblocks "get, check in Chrome, cut over").
2. DVX provenance (`dvx-pipeline.md`).
3. Pulumi import of existing resources.
4. Batch.

## Open questions

- Keep `jct-edge.ryan-0dc.workers.dev` as prod's alias, or disable `workers_dev` on prod once dev exists?
