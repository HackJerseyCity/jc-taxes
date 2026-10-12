const { test } = require('node:test');
const { deepStrictEqual, rejects } = require('node:assert');
const gate = require('./preview-gate.cjs');

function fixture(permission, command = '/preview') {
  const outputs = {}, comments = [], reactions = [], users = [];
  const sha = 'a'.repeat(40);
  const github = { rest: {
    pulls: { get: async () => ({ data: { state: 'open', draft: false, base: { ref: 'main' }, head: { sha }, user: { login: 'author' } } }) },
    repos: { getCollaboratorPermissionLevel: async ({ username }) => { users.push(username); return { data: { permission } }; } },
    issues: { createComment: async (c) => comments.push(c) },
    reactions: { createForIssueComment: async (r) => reactions.push(r) },
  } };
  const context = { eventName: 'issue_comment', repo: { owner: 'org', repo: 'repo' }, runId: 123,
    payload: { issue: { number: 2, pull_request: {} }, comment: { id: 7, body: command, user: { login: 'approver' } } } };
  const core = { notice() {}, setOutput: (k, v) => { outputs[k] = v; } };
  return { github, context, core, outputs, comments, reactions, users, sha };
}

test('write collaborator approves the exact head with audit and acknowledgment', async () => {
  const f = fixture('write');
  await gate(f);
  deepStrictEqual(f.users, ['approver']);
  deepStrictEqual(f.outputs, { sha: f.sha, pr: '2' });
  deepStrictEqual(f.reactions, [{ owner: 'org', repo: 'repo', comment_id: 7, content: 'eyes' }]);
  deepStrictEqual(f.comments, [{ owner: 'org', repo: 'repo', issue_number: 2,
    body: `Preview approved by @approver for \`${f.sha}\`. [Build progress](https://github.com/org/repo/actions/runs/123).\n\nWrite collaborators can request another build with \`/preview\` or \`/preview <full head SHA>\`.` }]);
});

test('read/triage users cannot approve', async () => {
  for (const permission of ['read', 'triage', undefined]) {
    const f = fixture(permission);
    await gate(f);
    deepStrictEqual([f.outputs, f.comments, f.reactions], [{}, [], []]);
  }
});

test('approval of an old commit does not authorize a new head', async () => {
  const f = fixture('admin', `/preview ${'b'.repeat(40)}`);
  await rejects(gate(f), { message: 'Requested commit is not the current PR head; approval was not carried forward' });
  deepStrictEqual([f.outputs, f.comments, f.reactions], [{}, [], []]);
});

test('non-command comments never authorize anything', async () => {
  for (const command of ['/preview junk', '/preview\nanything', 'hello']) {
    const f = fixture('admin', command);
    await gate(f);
    deepStrictEqual([f.outputs, f.users, f.comments], [{}, [], []]);
  }
});
