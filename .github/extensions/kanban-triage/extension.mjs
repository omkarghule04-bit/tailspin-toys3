import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

const servers = new Map();

const priorityLabels = new Map([
    ['security', 100],
    ['blocker', 90],
    ['critical', 85],
    ['high priority', 75],
    ['bug', 55],
    ['enhancement', 20],
]);

function getRepository() {
    if (process.env.GITHUB_REPOSITORY) {
        return process.env.GITHUB_REPOSITORY;
    }

    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
    }).trim();
    const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (!match) {
        throw new Error('Unable to determine the GitHub repository from git remote.');
    }
    return match[1];
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function scoreIssue(issue) {
    const labelScore = issue.labels.reduce((total, label) => {
        return total + (priorityLabels.get(label.name.toLowerCase()) ?? 0);
    }, 0);
    const ageInDays = Math.max(0, (Date.now() - Date.parse(issue.updated_at)) / 86400000);
    const activityScore = Math.min(issue.comments * 2, 20);
    const recencyScore = Math.max(0, 30 - ageInDays);
    return labelScore + activityScore + recencyScore;
}

function issueReason(issue, rank) {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    const reasons = [];
    if (labels.some((label) => ['security', 'blocker', 'critical'].includes(label))) {
        reasons.push('it carries a critical-impact label');
    } else if (labels.includes('bug')) {
        reasons.push('it is marked as a bug');
    }
    if (issue.comments > 0) {
        reasons.push(`it has ${issue.comments} comment${issue.comments === 1 ? '' : 's'}`);
    }
    if (!reasons.length) {
        reasons.push('it is among the most recently updated open issues');
    }
    return rank === 1
        ? `Top priority because ${reasons.join(' and ')}.`
        : `Ranked here because ${reasons.join(' and ')}.`;
}

async function loadIssues() {
    const repository = getRepository();
    const response = await fetch(`https://api.github.com/repos/${repository}/issues?state=open&per_page=100`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'kanban-triage-canvas',
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub issues request failed with ${response.status}.`);
    }
    const issues = (await response.json()).filter((issue) => !issue.pull_request);
    return issues
        .map((issue) => ({ ...issue, triageScore: scoreIssue(issue) }))
        .sort((left, right) => right.triageScore - left.triageScore || Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

function issueCard(issue, reason = '') {
    const labels = issue.labels
        .map((label) => `<span class="label">${escapeHtml(label.name)}</span>`)
        .join('');
    return `<article class="card">
        <div class="card-header"><span class="number">#${issue.number}</span><span class="date">${new Date(issue.updated_at).toLocaleDateString()}</span></div>
        <h3>${escapeHtml(issue.title)}</h3>
        <p>${escapeHtml(issue.body || 'No description provided.')}</p>
        <div class="labels">${labels || '<span class="label muted">unlabeled</span>'}</div>
        ${reason ? `<p class="reason"><strong>Why now:</strong> ${escapeHtml(reason)}</p>` : ''}
        <button data-issue="${issue.number}">Add to current context</button>
    </article>`;
}

function renderHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issue triage</title>
<style>
:root { color-scheme: light dark; --bg: var(--background-color-default, #fff); --text: var(--text-color-default, #1f2328); --muted: var(--text-color-muted, #656d76); --border: var(--border-color-default, #d0d7de); --accent: var(--true-color-blue, #0969da); }
* { box-sizing: border-box; } body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font-sans, system-ui, sans-serif); }
main { max-width: 1000px; margin: auto; } h1 { margin: 0 0 4px; font-size: 26px; } h2 { margin: 28px 0 12px; font-size: 18px; } .subtle, .date { color: var(--muted); }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); } .card { border: 1px solid var(--border); border-radius: 10px; padding: 16px; background: color-mix(in srgb, var(--bg) 94%, var(--accent)); }
.card-header { display: flex; justify-content: space-between; } .number { color: var(--accent); font-weight: 700; } h3 { margin: 8px 0; font-size: 16px; } p { margin: 8px 0; } .labels { display: flex; flex-wrap: wrap; gap: 5px; margin: 12px 0; }
.label { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 12px; } .muted { color: var(--muted); } .reason { color: var(--muted); font-size: 13px; }
button { border: 0; border-radius: 6px; padding: 8px 12px; background: var(--accent); color: white; cursor: pointer; } button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; } button:disabled { opacity: .6; cursor: wait; }
#status { min-height: 22px; margin-top: 16px; color: var(--muted); } .error { color: var(--true-color-red, #cf222e); }
</style></head>
<body><main>
<h1>Issue triage</h1><div class="subtle">Open issues ranked by impact, activity, and recency.</div>
<div id="status" role="status" aria-live="polite">Loading issues…</div>
<section><h2>Needs attention now</h2><div id="priority" class="grid"></div></section>
<section><h2>Remaining open issues</h2><div id="remainder" class="grid"></div></section>
</main>
<script>
const status = document.querySelector('#status');
const escapeText = (text) => { const element = document.createElement('span'); element.textContent = text ?? ''; return element.innerHTML; };
const card = (issue, reason) => '<article class="card"><div class="card-header"><span class="number">#' + issue.number + '</span><span class="date">' + new Date(issue.updated_at).toLocaleDateString() + '</span></div><h3>' + escapeText(issue.title) + '</h3><p>' + escapeText(issue.body || 'No description provided.') + '</p><div class="labels">' + (issue.labels.map((label) => '<span class="label">' + escapeText(label.name) + '</span>').join('') || '<span class="label muted">unlabeled</span>') + '</div>' + (reason ? '<p class="reason"><strong>Why now:</strong> ' + escapeText(reason) + '</p>' : '') + '<button data-issue="' + issue.number + '">Add to current context</button></article>';
async function load() {
    try {
        const response = await fetch('/api/issues');
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        document.querySelector('#priority').innerHTML = data.priority.map((item) => card(item.issue, item.reason)).join('') || '<p class="subtle">No open issues.</p>';
        document.querySelector('#remainder').innerHTML = data.remainder.map((issue) => card(issue, '')).join('') || '<p class="subtle">No remaining issues.</p>';
        status.textContent = data.repository + ' · ' + data.total + ' open issue' + (data.total === 1 ? '' : 's');
    } catch (error) { status.textContent = 'Could not load issues: ' + error.message; status.className = 'error'; }
}
document.addEventListener('click', async (event) => {
    if (!event.target.matches('button[data-issue]')) return;
    const button = event.target; button.disabled = true; status.textContent = 'Adding issue to the current context…';
    const response = await fetch('/api/add-context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: Number(button.dataset.issue) }) });
    status.textContent = response.ok ? 'Issue added to the current context.' : 'Could not add issue to context.';
    button.disabled = false;
});
load();
</script></body></html>`;
}

async function startServer() {
    const server = createServer(async (request, response) => {
        try {
            if (request.url === '/api/issues') {
                const issues = await loadIssues();
                const repository = getRepository();
                const priority = issues.slice(0, 3).map((issue, index) => ({
                    issue,
                    reason: issueReason(issue, index + 1),
                }));
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ repository, total: issues.length, priority, remainder: issues.slice(3) }));
                return;
            }
            if (request.url === '/api/add-context' && request.method === 'POST') {
                let body = '';
                for await (const chunk of request) body += chunk;
                const { number } = JSON.parse(body);
                const issues = await loadIssues();
                const issue = issues.find((candidate) => candidate.number === number);
                if (!issue) throw new Error('Issue not found or no longer open.');
                await session.send({
                    prompt: `Add GitHub issue #${issue.number} to the current context and start working on it. Title: ${issue.title}. URL: ${issue.html_url}. Description: ${issue.body || 'No description provided.'}`,
                });
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(renderHtml());
        } catch (error) {
            response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end(error instanceof Error ? error.message : 'Unexpected canvas error.');
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, url: `http://127.0.0.1:${address.port}/` };
}

let session;
session = await joinSession({
    canvases: [
        createCanvas({
            id: 'kanban-triage',
            displayName: 'Issue triage board',
            description: 'A Kanban-style board that ranks open GitHub issues and adds selected issues to the current context.',
            actions: [
                {
                    name: 'refresh_issues',
                    description: 'Refresh the triage board data from GitHub.',
                    handler: async () => ({ refreshed: true }),
                },
                {
                    name: 'add_issue_to_context',
                    description: 'Add an open issue to the current session context and begin work on it.',
                    inputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
                    handler: async ({ input }) => {
                        const issues = await loadIssues();
                        const issue = issues.find((candidate) => candidate.number === input.number);
                        if (!issue) throw new Error('Issue not found or no longer open.');
                        await session.send({ prompt: `Add GitHub issue #${issue.number} to the current context and start working on it. Title: ${issue.title}. URL: ${issue.html_url}. Description: ${issue.body || 'No description provided.'}` });
                        return { added: issue.number };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                return { title: 'Issue triage board', url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(resolve));
                }
            },
        }),
    ],
});
