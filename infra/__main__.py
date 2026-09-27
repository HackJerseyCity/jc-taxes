"""Cloudflare infrastructure for jc-taxes (RAC account; see `specs/infra-dev-stack.md`).

- R2 `jc-taxes` (DVC cache + app data, served by the Worker's `/d` route) and
  `jct-og` (OG map captures + rendered cards): imported, protected.
- `jc-taxes` CORS (R2 CORS can't be imported; `create` is a full-replace PUT,
  so it adopts the existing rules idempotently).
- D1 `jct` (prod) and `jct-dev`: imported, protected.
- Worker custom domains: `jct.rbw.sh` → `jct-edge`, `jct-files.rbw.sh` →
  `jct-files` (imported); `jct-dev.rbw.sh` → `jct-edge-dev` (created, gated by
  `dev_domain`). One label under `rbw.sh`, so Universal SSL covers them; a
  two-label `dev.jct.rbw.sh` would need paid Advanced Certificate Manager.

Not managed: the `data.jct.rbw.sh` R2 custom domain (`R2CustomDomain` can't be
imported, and creating over the live one would fail); Worker scripts
(wrangler-deployed; `edge/wrangler.jsonc` bindings reference the names / ids
exported below).
"""
import pulumi
import pulumi_cloudflare as cf

config = pulumi.Config()
account_id = config.require('cloudflare_account_id')
zone_id = config.require('zone_id')  # rbw.sh
dev_domain = config.get_bool('dev_domain') is True

protect = pulumi.ResourceOptions(protect=True)


def imported(id: str) -> pulumi.ResourceOptions:
    return pulumi.ResourceOptions(import_=id, protect=True)


# ── R2 ──
buckets = {
    name: cf.R2Bucket(
        name,
        account_id=account_id,
        name=name,
        location='ENAM',
        opts=imported(f'{account_id}/{name}/default'),
    )
    for name in ('jc-taxes', 'jct-og')
}

cf.R2BucketCors(
    'jc-taxes-cors',
    account_id=account_id,
    bucket_name=buckets['jc-taxes'].name,
    rules=[cf.R2BucketCorsRuleArgs(
        allowed=cf.R2BucketCorsRuleAllowedArgs(
            methods=['GET', 'HEAD'],
            origins=['https://jct.rbw.sh', 'http://localhost:3201', 'http://localhost:4173'],
            headers=['*'],
        ),
        expose_headers=['Content-Length', 'Content-Range', 'Content-Type', 'ETag', 'Accept-Ranges'],
        max_age_seconds=3600,
    )],
)

# ── D1 ──
D1 = {
    'jct': '5e171033-64c2-4cc4-8388-40eef7846227',
    'jct-dev': '1549563d-77c7-4abc-806e-42f339e38815',
}
d1 = {
    name: cf.D1Database(
        f'd1-{name}',
        account_id=account_id,
        name=name,
        read_replication={'mode': 'disabled'},
        opts=imported(f'{account_id}/{id}'),
    )
    for name, id in D1.items()
}

# ── Worker custom domains ──
# hostname → (Worker, existing domain id to import, or None to create)
DOMAINS = {
    'jct.rbw.sh': ('jct-edge', '4ec04f11fe6787325647b3d1a7c2223cdab8989b'),
    'jct-files.rbw.sh': ('jct-files', '59e0463efd397146cacc02edaa82d23bfa7d794c'),
    **({'jct-dev.rbw.sh': ('jct-edge-dev', None)} if dev_domain else {}),
}
for hostname, (service, domain_id) in DOMAINS.items():
    cf.WorkersCustomDomain(
        f'wcd-{hostname}',
        account_id=account_id,
        hostname=hostname,
        service=service,
        zone_id=zone_id,
        environment='production',
        opts=imported(f'{account_id}/{domain_id}') if domain_id else protect,
    )

pulumi.export('buckets', list(buckets))
pulumi.export('d1_database_ids', {name: db.id for name, db in d1.items()})
pulumi.export('worker_domains', {h: s for h, (s, _) in DOMAINS.items()})
