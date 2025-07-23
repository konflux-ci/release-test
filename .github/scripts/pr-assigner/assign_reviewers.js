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
    const currentPR = await getPRDetails();
    const currentReviewers = currentPR.requested_reviewers.map(r => r.login);
    const reviewersToActuallyAdd = newReviewers.filter(r => !currentReviewers.includes(r));

    if (reviewersToActuallyAdd.length > 0) {
        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
            owner, repo, pull_number: prNumber,
            reviewers: reviewersToActuallyAdd
        });
        return reviewersToActuallyAdd;
    }
    return [];
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
        eventType === "ready_for_review" ||
        eventType === "review_request_removed";

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
                const addedReviewers = await assignReviewers(toAdd);
                if (addedReviewers.length > 0) {
                    let msg = `🕵️ Reviewer update for PR #${prNumber} ${prLink} in \`${repo}\`: ${mention(addedReviewers, userMap)}`;
                    if (eventType === "review_request_removed") {
                        msg = `⚠️ Reviewer(s) removed from PR #${prNumber} ${prLink} in \`${repo}\`. Added ${mention(addedReviewers, userMap)} to meet review requirements.`;
                    }
                    await notifySlack(msg);
                }
            } else if (needed > 0 && available.length === 0) {
                const msg = `❗️ Reviewers needed for PR #${prNumber} ${prLink} in \`${repo}\` but no available candidates to assign.`;
                await notifySlack(msg);
            }
        } else if (currentReviewers.length >= 2 && eventType === "review_request_removed") {
            console.log(`Reviewer removed from PR #${prNumber}, but enough reviewers (${currentReviewers.length}) still remain.`);
        }
    }
})();
