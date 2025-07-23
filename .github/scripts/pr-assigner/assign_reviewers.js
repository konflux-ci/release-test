const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const prNumber = process.env.PR_NUMBER;
const eventType = process.env.EVENT_TYPE;
const userMapURL = process.env.USER_MAP_URL;
// const removedReviewer = process.env.REMOVED_REVIEWER; // We will no longer use this specific variable

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
    // Before assigning, always fetch current reviewers again to avoid race conditions
    // if multiple 'review_request_removed' events fire very rapidly.
    const currentPR = await getPRDetails();
    const currentReviewers = currentPR.requested_reviewers.map(r => r.login);
    const reviewersToActuallyAdd = newReviewers.filter(r => !currentReviewers.includes(r));

    if (reviewersToActuallyAdd.length > 0) {
        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
            owner, repo, pull_number: prNumber,
            reviewers: reviewersToActuallyAdd
        });
        return reviewersToActuallyAdd; // Return who was actually added
    }
    return []; // Nothing was added
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
        eventType === "review_request_removed"; // Include review_request_removed here

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
                const addedReviewers = await assignReviewers(toAdd); // Use the modified assignReviewers
                if (addedReviewers.length > 0) {
                    let msg = `🕵️ Reviewer update for PR #${prNumber} ${prLink} in \`${repo}\`: ${mention(addedReviewers, userMap)}`;
                    // Optional: Add more context for review_request_removed events
                    if (eventType === "review_request_removed") {
                        // We can't know _who_ was removed in bulk directly from this single trigger,
                        // but we know we just added someone because reviewers were needed.
                        msg = `⚠️ Reviewer(s) removed from PR #${prNumber} ${prLink} in \`${repo}\`. Added ${mention(addedReviewers, userMap)} to meet review requirements.`;
                    }
                    await notifySlack(msg);
                }
            } else if (needed > 0 && available.length === 0) {
                // Case where reviewers are needed but no one is available to add.
                // You might want to notify here too.
                const msg = `❗️ Reviewers needed for PR #${prNumber} ${prLink} in \`${repo}\` but no available candidates to assign.`;
                await notifySlack(msg);
            }
        } else if (currentReviewers.length >= 2 && eventType === "review_request_removed") {
            // If a reviewer was removed but 2 or more reviewers still remain,
            // you might still want a notification, or simply do nothing.
            // For this scenario, if you don't want an extra reviewer assigned,
            // then no action is needed here.
            // If you want a notification that a reviewer was removed but not replaced
            // because enough remain, you could add it here.
            console.log(`Reviewer removed from PR #${prNumber}, but enough reviewers (${currentReviewers.length}) still remain.`);
        }
    }

    // This block is completely removed as its functionality is now covered by the
    // main 'shouldAssign' block, which ensures the minimum number of reviewers.
    // if (eventType === "review_request_removed" && removedReviewer) {
    //     const remaining = currentReviewers.filter(r => r !== removedReviewer);
    //     const available = candidates.filter(r =>
    //         !remaining.includes(r) && r !== removedReviewer
    //     );

    //     const toAdd = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : null;

    //     if (toAdd) {
    //         const newReviewers = [...remaining, toAdd];
    //         await assignReviewers(newReviewers);
    //         const msg = `⚠️ Reviewer ${mention([removedReviewer], userMap)} was removed from PR #${prNumber} ${prLink} in \`${repo}\`. Replaced by ${mention([toAdd], userMap)}.`;
    //         await notifySlack(msg);
    //     }
    // }
})();
