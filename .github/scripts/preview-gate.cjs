const COMMAND = /^\/preview(?:\s+([0-9a-f]{40}))?$/i;

module.exports = async function gate({ github, context, core }) {
  const payload = context.payload;
  const comment = context.eventName === 'issue_comment';
  const match = comment && payload.comment.body.trim().match(COMMAND);
  if (comment && (!payload.issue.pull_request || !match)) return;
  const number = Number(comment ? payload.issue.number : payload.pull_request?.number || payload.inputs?.pr);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  if (pr.state !== 'open' || pr.base.ref !== 'main' || pr.draft) throw new Error('Expected open, non-draft PR targeting main');
  const login = comment ? payload.comment.user.login
    : context.eventName === 'workflow_dispatch' ? context.actor : pr.user.login;
  let permission;
  try {
    const result = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: login });
    permission = result.data.permission;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!['write', 'maintain', 'admin'].includes(permission)) {
    core.notice('A write collaborator must comment /preview or run PR preview manually.');
    return;
  }
  if (match?.[1] && match[1].toLowerCase() !== pr.head.sha.toLowerCase()) {
    throw new Error('Requested commit is not the current PR head; approval was not carried forward');
  }
  if (comment) {
    await github.rest.reactions.createForIssueComment({ ...context.repo, comment_id: payload.comment.id, content: 'eyes' });
  }
  const run = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  await github.rest.issues.createComment({ ...context.repo, issue_number: number,
    body: `Preview approved by @${login} for \`${pr.head.sha}\`. [Build progress](${run}).\n\nWrite collaborators can request another build with \`/preview\` or \`/preview <full head SHA>\`.` });
  core.setOutput('sha', pr.head.sha);
  core.setOutput('pr', String(number));
};
