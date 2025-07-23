const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");
const fs = require("fs");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });

async function getUserMap() {
    const res = await fetch(process.env.USER_MAP_URL);
    const text = await res.text();
    return yaml.parse(text);
}

function mention(users, map) {
    return users.map(user => {
        const entry = map[user];
        if (!entry) return `@${user}`;
        return entry.notify === false ? `@${user}` : `<@${entry.slack_id}>`;
    }).join(", ");
}

async function notifySlack(message) {
    if (!process.env.SLACK_WEBHOOK_URL) return;
    const payload = { text: message };
    console.log("🔔 Sending Slack notification:", message);
    await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" }
    });
}

async function assignReviewers(reviewers) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    const prNumber = +process.env.PR_NUMBER;
    console.log("👥 Assigning reviewers via GitHub API:", reviewers);
    await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        owner,
        repo,
        pull_number: prNumber,
        reviewers
    });
}

async function main() {
    const userMap = await getUserMap();
    const reviewers = Object.keys(userMap).filter(user => userMap[user].eligible !== false);
    console.log("📋 Eligible reviewers from user map:", reviewers);

    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    const prNumber = +process.env.PR_NUMBER;
    const eventType = process.env.GITHUB_EVENT_NAME;
    const prLink = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

    const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber
    });

    const currentReviewers = pr.requested_reviewers.map(r => r.login);
    console.log("🔍 Current reviewers on PR:", currentReviewers);

    if (eventType === "pull_request") {
        const action = process.env.PR_ACTION;
        console.log(`📦 PR action detected: ${action}, Draft: ${pr.draft}`);

        if (action === "opened" && !pr.draft) {
            const available = reviewers.filter(r => !currentReviewers.includes(r));
            const selected = [];
            const pool = available.slice();

            while (selected.length < 2 && pool.length > 0) {
                const idx = Math.floor(Math.random() * pool.length);
                selected.push(pool.splice(idx, 1)[0]);
            }

            console.log("🎯 PR opened — assigning reviewers:", selected);

            if (selected.length > 0) {
                await assignReviewers(selected);
                const msg = `📌 PR #${prNumber} ${prLink} in \`${repo}\` opened — assigned to ${mention(selected, userMap)}.`;
                await notifySlack(msg);
            }
        }

        if (action === "ready_for_review" && currentReviewers.length < 2) {
            const needed = 2 - currentReviewers.length;
            const available = reviewers.filter(r => !currentReviewers.includes(r));
            const selected = [];
            const pool = available.slice();

            while (selected.length < needed && pool.length > 0) {
                const idx = Math.floor(Math.random() * pool.length);
                selected.push(pool.splice(idx, 1)[0]);
            }

            console.log("🎯 PR marked ready — assigning missing reviewers:", selected);

            if (selected.length > 0) {
                await assignReviewers(selected);
                const msg = `📌 PR #${prNumber} ${prLink} in \`${repo}\` marked ready — added ${mention(selected, userMap)} as reviewers.`;
                await notifySlack(msg);
            }
        }
    }

    if (eventType === "review_request_removed") {
        const eventPath = process.env.GITHUB_EVENT_PATH;
        const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));

        let removedReviewers = [];
        if (eventData.requested_reviewers_removed && eventData.requested_reviewers_removed.length > 0) {
            removedReviewers = eventData.requested_reviewers_removed.map(r => r.login);
        } else if (process.env.REMOVED_REVIEWER) {
            removedReviewers = [process.env.REMOVED_REVIEWER];
        }

        const remaining = currentReviewers.filter(r => !removedReviewers.includes(r));
        const available = reviewers.filter(r =>
            !remaining.includes(r) && !removedReviewers.includes(r)
        );

        const toAdd = [];
        const pool = available.slice();

        while (toAdd.length < removedReviewers.length && pool.length > 0) {
            const idx = Math.floor(Math.random() * pool.length);
            toAdd.push(pool.splice(idx, 1)[0]);
        }

        console.log("=== 🔁 Reviewer Removal Debug Info ===");
        console.log("🧹 Removed reviewers:", removedReviewers);
        console.log("📌 Remaining reviewers:", remaining);
        console.log("👤 Eligible reviewers:", reviewers);
        console.log("📤 Available for reassignment:", available);
        console.log("✅ Selected replacements:", toAdd);
        console.log("======================================");

        if (toAdd.length > 0) {
            await assignReviewers(toAdd);
            const msg = `⚠️ Reviewers ${mention(removedReviewers, userMap)} were removed from PR #${prNumber} ${prLink} in \`${repo}\`. Replaced by ${mention(toAdd, userMap)}.`;
            await notifySlack(msg);
        } else {
            console.log("⚠️ No reviewers added after removal — not enough available or already assigned.");
        }
    }
}

main().catch(err => {
    console.error("❌ Script failed:", err);
    process.exit(1);
});
