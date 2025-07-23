const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const prNumber = process.env.PR_NUMBER;
const eventType = process.env.EVENT_TYPE;
const userMapURL = process.env.USER_MAP_URL;
const removedReviewer = process.env.REMOVED_REVIEWER;

async function getUserMap() {
    try {
        const res = await fetch(userMapURL);
        if (!res.ok) throw new Error(`Failed to fetch user map: ${res.statusText}`);
        const text = await res.text();
        const parsed = yaml.parse(text);
        return parsed.users || {};
    } catch (error) {
        console.error("Error loading user map:", error);
        return {};
    }
}

async function getPRDetails() {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner, repo, pull_number: prNumber
    });
    return res.data;
}

async function assignReviewers(newReviewers) {
    await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        owner, repo, pull_number: prNumber,
        reviewers: newReviewers
    });
}

function mention(users, userMap) {
    return users.map(u => {
        const info = userMap[u];
        if (!info) return `@${u}`;
        return info.notify === false ? `@${info.slack_id}` : `<@${info.slack_id}>`;
    }).join(" ");
}

async function notifySlack(text) {
    if (!process.env.SLACK_WEBHOOK) return;
    await fetch(process.env.SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
}

(async () => {
    const pr = await getPRDetails();
    const prTitle = pr.title;
    const prUrl = pr.html_url;
    const prLink = `<${prUrl}|${prTitle}>`;
    const userMap = await getUserMap();
    const allUsers = Object.entries(userMap)
        .filter(([_, v]) => v.assign !== false)
        .map(([k]) => k);
    const author = pr.user.login;

    const candidates = allUsers.filter(u => u !== author);
    const currentReviewers = pr.requested_reviewers.map(r => r.login);

    if (eventType === "opened" || eventType === "reopened") {
        const reviewers = [];
        const pool = candidates.slice();

        while (reviewers.length < 2 && pool.length > 0) {
            const idx = Math.floor(Math.random() * pool.length);
            reviewers.push(pool.splice(idx, 1)[0]);
        }

        if (reviewers.length > 0) {
            await assignReviewers(reviewers);
            const msg = `🕵️ Reviewer assignment for PR #${prNumber} ${prLink} in \`${repo}\`: ${mention(reviewers, userMap)}`;
            await notifySlack(msg);
        }
    }

    if (eventType === "review_request_removed" && removedReviewer) {
        const remaining = currentReviewers.filter(r => r !== removedReviewer);
        const available = candidates.filter(r =>
            !remaining.includes(r) && r !== removedReviewer
        );

        const toAdd = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : null;

        if (toAdd) {
            const newReviewers = [...remaining, toAdd];
            await assignReviewers(newReviewers);
            const msg = `⚠️ Reviewer ${mention([removedReviewer], userMap)} was removed from PR #${prNumber} ${prLink} in \`${repo}\`. Replaced by ${mention([toAdd], userMap)}.`;
            await notifySlack(msg);
        }
    }
})();
