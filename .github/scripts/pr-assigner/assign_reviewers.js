const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");

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

async function notifySlack(users, reason) {
//    if (!process.env.SLACK_WEBHOOK) return;

    const userMap = await getUserMap();
    const mentions = users.map(u => userMap[u] || u).join(" ");
    const msg = {
        text: `📣 *${reason}* on PR #${prNumber} in \`${repo}\`: ${mentions}`,
    };
    console.log(msg)
    /*
    await fetch(process.env.SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
    });
    */
}

(async () => {
    const pr = await getPRDetails();
    const userMap = await getUserMap();
    const allUsers = Object.keys(userMap);
    const author = pr.user.login;

    // Exclude PR author and current reviewers
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
            await notifySlack(reviewers, "Reviewers assigned");
        }
    }

    if (eventType === "unassigned") {
        const available = candidates.filter(r => !currentReviewers.includes(r));
        const toAdd = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : null;

        if (toAdd) {
            await assignReviewers([toAdd]);
            await notifySlack([toAdd], "Reviewer reassigned (previous removed)");
        }
    }
})();
