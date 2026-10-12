# PR previews

`.github/workflows/preview.yml` automatically previews open, non-draft PRs targeting `main` whose author currently has write, maintain or admin permission. Invitations must be accepted first; there is no permanent username allowlist.

For other contributors, a write collaborator comments `/preview` on the PR, or `/preview <full head SHA>` to reject the request if the head has changed. **Actions → PR preview → Run workflow** remains available: select `main` and enter the PR number. Both methods approve the captured head SHA, not future commits. Subsequent external updates require another approval. The bot acknowledges accepted comments with an eyes reaction, posts a commit-specific build link, and posts the preview URL on success. Reactions themselves are not approval triggers.

The build/test runner has no Cloudflare credential. A separate deployment runner uses trusted `main` tooling and an allowlisted configuration to upload only built assets and Worker modules. Previews share `jct-dev` D1 and the existing R2 bindings, not production D1. Approved Worker code can write those bound buckets, including shared `jc-taxes`; do not approve arbitrary code without reviewing its resource access. A narrower token and dedicated preview buckets would further reduce this exposure.

Stable URLs are `https://jct-pr-N.ryan-0dc.workers.dev`. `prN.jct.rbw.sh` aliases are optional and not provisioned by the workflow. Preview Workers persist after PR closure; retirement is currently manual. Existing main-to-dev and manual production promotion remain unchanged.

The workflow and trusted configuration generator must land on `main` before this can be exercised. Production promotion remains a separate manual operation.
