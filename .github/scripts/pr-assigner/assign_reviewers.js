const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });

const repo = process.env.GITHUB_REPOSITORY;
const [owner, repoName] = repo.split("/");
const prNumber = process.env.PR_NUMBER;
const eventType = process.env.EVENT_TYPE;
const removedReviewers = JSON.parse(process.env.REMOVED_REVIEWERS || "[]").map(r => r.login);

const prLink = `https://github.com/${repo}/pull/${prNumber}`;

async function getPRDetails() {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo: repoName,
        pull_number: prNumber,
    });
    return res.data;
}

async function assignReviewers(reviewers) {
    await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        owner,
        repo: repoName,
        pull_number: prNumber,
        reviewers,
    });
}

async function notifySlack(message) {
    const webhook = process.env.SLACK_WEBHOOK;
    if (!webhook) return;

    await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
    });
}

async function getUserMap() {
    const res = await fetch(process.env.USER_MAP_URL);
    return await res.json();
}

function mention(users, userMap) {
    return users.map(user => {
        const map = userMap[user] || {};
        if (map.notify === false || !map.slack_id) return `@${user}`;
        return `<@${map.slack_id}>`;
    }).join(", ");
}

function chooseTwoRandom(array) {
    const shuffled = array.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 2);
}

(async () => {
    const pr = await getPRDetails();
    const author = pr.user.login;
    const currentReviewers = pr.requested_reviewers.map(r => r.login);
    const userMap = await getUserMap();

    const candidates = Object.entries(userMap)
        .filter(([user, data]) => data.assign !== false && user !== author)
        .map(([user]) => user);

    if (eventType === "opened" || eventType === "ready_for_review") {
        const available = candidates.filter(r => !currentReviewers.includes(r));
        const selected = chooseTwoRandom(available);

        if (selected.length > 0) {
            await assignReviewers(selected);
            const msg = `👀 PR #${prNumber} ${prLink} in \`${repo}\` assigned to ${mention(selected, userMap)}.`;
            await notifySlack(msg);
        }

    } else if (eventType === "review_request_removed" && removedReviewers.length > 0) {
        const remaining = currentReviewers.filter(r => !removedReviewers.includes(r));
        const available = candidates.filter(r =>
            !remaining.includes(r) && !removedReviewers.includes(r)
        );

        const toAdd = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : null;

        if (toAdd) {
            const newReviewers = [...remaining, toAdd];
            await assignReviewers(newReviewers);
            const msg = `⚠️ Reviewer(s) ${mention(removedReviewers, userMap)} were removed from PR #${prNumber} ${prLink} in \`${repo}\`. Replaced by ${mention([toAdd], userMap)}.`;
            await notifySlack(msg);
        }
    }
})();
