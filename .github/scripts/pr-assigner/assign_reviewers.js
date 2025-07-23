// .github/scripts/pr-assigner/assign_reviewers.js

const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });

async function getUserMap() {
    const res = await fetch(process.env.USER_MAP_URL);
    const text = await res.text();
    return yaml.parse(text);
}

async function assignReviewers(owner, repo, pull_number, excludedUsers) {
    const userMap = await getUserMap();

    const eligibleUsers = Object.entries(userMap)
        .filter(([_, meta]) => meta.assignable !== false)
        .map(([username]) => username)
        .filter(username => !excludedUsers.includes(username));

    if (eligibleUsers.length < 2) {
        console.warn("Not enough eligible reviewers");
        return;
    }

    const reviewers = [];
    while (reviewers.length < 2) {
        const idx = Math.floor(Math.random() * eligibleUsers.length);
        const candidate = eligibleUsers[idx];
        if (!reviewers.includes(candidate)) {
            reviewers.push(candidate);
        }
    }

    console.log(`Assigning reviewers: ${reviewers.join(", ")}`);

    await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        owner,
        repo,
        pull_number,
        reviewers,
    });

    await notifySlack(reviewers, userMap);
}

async function notifySlack(reviewers, userMap) {
    const mentions = reviewers.map(user => {
        const info = userMap[user];
        if (!info || info.notify === false || !info.slack_id) {
            return `@${user}`;
        }
        return `<@${info.slack_id}>`;
    });

    const body = {
        text: `PR assigned to: ${mentions.join(", ")}`,
    };

    await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
    });
}

async function main() {
    const payload = JSON.parse(process.env.GITHUB_EVENT_PAYLOAD);
    const action = payload.action;
    const pr = payload.pull_request;
    const repo = payload.repository;

    // Skip if the PR is a draft
    if (pr.draft) {
        console.log("Draft PR, skipping reviewer assignment.");
        return;
    }

    // Ensure that removed reviewers are correctly handled
    const removedReviewers = JSON.parse(process.env.REMOVED_REVIEWERS || "[]").map(r => r.login);
    const currentReviewers = pr.requested_reviewers.map(r => r.login);

    const excludedUsers = removedReviewers.concat(currentReviewers); // Exclude removed reviewers and current ones

    if (action === "opened" || action === "ready_for_review") {
        await assignReviewers(repo.owner.login, repo.name, pr.number, excludedUsers);
    } else if (action === "review_request_removed" && removedReviewers.length > 0) {
        await assignReviewers(repo.owner.login, repo.name, pr.number, excludedUsers);
    } else {
        console.log(`No action needed for: ${action}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
