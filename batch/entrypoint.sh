#!/bin/sh
# Batch entrypoint: `dvx "$@"` (e.g. `run deploy/r2-br.dvc data/d1/aggregates.sql.dvc`),
# then push the regenerated `.dvc`s back as one commit on a results branch.
#
# One commit at the end rather than `dvx run --commit --push each`: parallel
# stages' per-stage pushes race (see crashes' batch/entrypoint.sh). Without
# $GITHUB_RW_TOKEN (injected by Batch from Secrets Manager) it runs read-only.
set -e

# `.dvc/config`'s `r2` remote authenticates via AWS profile `cf`; rebuild it
# from the R2 keys Batch injects from Secrets Manager.
if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
    mkdir -p ~/.aws
    printf '[cf]\naws_access_key_id = %s\naws_secret_access_key = %s\n' \
        "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" > ~/.aws/credentials
    chmod 600 ~/.aws/credentials
fi

push_back=no
if [ -n "${GITHUB_RW_TOKEN:-}" ]; then
    git -C /app remote set-url --push origin \
        "https://x-access-token:${GITHUB_RW_TOKEN}@github.com/HackJerseyCity/jc-taxes.git"
    branch="${RESULTS_BRANCH:-pipeline/$(date -u +%Y%m%d-%H%M%S)}"
    git -C /app checkout -B "$branch"
    push_back=yes
    echo "entrypoint: will commit+push regenerated .dvc to origin/$branch" >&2
else
    echo "entrypoint: no GITHUB_RW_TOKEN; no git push-back" >&2
fi

set +e
dvx "$@"
rc=$?
set -e

if [ "$push_back" = yes ]; then
    cd /app
    git add -u
    if git diff --cached --quiet; then
        echo "entrypoint: no .dvc changes" >&2
    else
        n=$(git diff --cached --name-only | wc -l | tr -d ' ')
        git commit -q -m "Pipeline run: $n \`.dvc\` updated @ $(date -u +%FT%TZ)"
        git push -u origin HEAD || { echo "entrypoint: push failed" >&2; [ "$rc" -eq 0 ] && rc=1; }
    fi
fi
exit "$rc"
