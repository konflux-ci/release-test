const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");
const fs = require("fs");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const prNumber = process.env.PR_NUMBER;
const eventType = process.env.EVENT_TYPE;
const userMapURL = process.env.USER_MAP_URL;

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

    const shouldAssign =
        (eventType === "opened" && !pr.draft) ||
        eventType === "ready_for_review";

    if (shouldAssign) {
        const needed = 2 - currentReviewers.length;

        if (needed > 0) {
            const available = candidates.filter(u => !currentReviewers.includes(u));
            const toAdd = [];

            const pool = available.slice();
            while (toAdd.length < needed && pool.length > 0) {
                const idx = Math.floor(Math.random() * pool.length);
                toAdd.push(pool.splice(idx, 1)[0]);
            }

            if (toAdd.length > 0) {
                await assignReviewers(toAdd);
                const msg = `🕵️ Reviewer update for PR #${prNumber} ${prLink} in \`${repo}\`: ${mention(toAdd, userMap)}`;
                await notifySlack(msg);
            }
        }
    }

    if (eventType === "review_request_removed") {
        const eventPath = process.env.GITHUB_EVENT_PATH;
        const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        const removedReviewers = (eventData.requested_reviewers_removed || []).map(r => r.login);

        const remaining = currentReviewers.filter(r => !removedReviewers.includes(r));
        const available = candidates.filter(r =>
            !remaining.includes(r) && !removedReviewers.includes(r)
        );

        const toAdd = [];

        const pool = available.slice();
        while (toAdd.length < removedReviewers.length && pool.length > 0) {
            const idx = Math.floor(Math.random() * pool.length);
            toAdd.push(pool.splice(idx, 1)[0]);
        }

        if (toAdd.length > 0) {
            const newReviewers = [...remaining, ...toAdd];
            await assignReviewers(newReviewers);
            const msg = `⚠️ Reviewers ${mention(removedReviewers, userMap)} were removed from PR #${prNumber} ${prLink} in \`${repo}\`. Replaced by ${mention(toAdd, userMap)}.`;
            await notifySlack(msg);
        }
    }
})();
