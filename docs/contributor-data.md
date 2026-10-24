# Contributor data uploads

Alfonso's private staging bucket is declared in the `rac` Pulumi stack as `jc-taxes-staging-alfonsoar`. Contributors receive object read/write permission only on their staging bucket. This allows deletion there, but grants no access to the canonical `jc-taxes` bucket. No public domain, browser CORS or automatic expiry is configured.

Status: bucket created on October 12, 2026. A contributor token was created manually in Cloudflare, and Alfonso's first three uploads were verified and promoted on October 13. Pulumi token issuance remains disabled; the existing deployment token received HTTP 403 from the account-token API. Contributor secrets are not retained in this repository.

Configure a separate DVX remote (do not change the canonical default):

```bash
dvx remote add aar-staging s3://jc-taxes-staging-alfonsoar/.dvc/cache
dvx remote modify aar-staging endpointurl https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com
dvx remote modify aar-staging profile jct-staging
dvx push -r aar-staging www/public/geom-lots.geojson.dvc www/public/geom-units.geojson.dvc data/modiv/treasury/2026.parquet.dvc
```

Install the issued access key and secret in the contributor's local AWS profile `jct-staging` via a private credential handoff. Never put secrets in `.dvc/config`, Git, PR comments or CI logs. The named profile can read/write/list/delete staging objects; canonical public objects remain anonymously readable over HTTPS.

Promotion runs with separate trusted canonical credentials, validates each PR-referenced object against its recorded MD5 and size, and uses conditional creation to prevent overwrites. Existing canonical objects are downloaded and verified rather than replaced. Uploads to staging alone do not publish data or grant production access.

```bash
python -m jc_taxes.cli r2 promote -n -s jc-taxes-staging-alfonsoar <PR-sidecars...>
python -m jc_taxes.cli r2 promote -s jc-taxes-staging-alfonsoar <PR-sidecars...>
```

The command currently supports standalone MD5 blobs, not directory manifests. It verifies the canonical bytes after each publication. It does not merge a PR, redeploy the site, or publish friendly-path aliases. If a later object fails, earlier successfully promoted objects remain available; rerunning verifies and skips those objects.

## Issuing credentials

The Pulumi stack optionally manages an expiring account token. Enable `staging_token` only after setting `staging_token_expires` (UTC timestamp). It looks up the account API's exact **Workers R2 Storage Bucket Item Write** permission group. The Pulumi administrator credential needs Account API Tokens Read/Write to create it; do not broaden the contributor token. The initial credential expires January 10, 2027.

`staging_credentials` is a secret Pulumi output. Export it only through a private, mode-0600 handoff file, not terminal stdout. The account token value is SHA-256-derived into its R2 secret access key. State and its backups must remain passphrase-encrypted.
