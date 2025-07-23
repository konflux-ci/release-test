const { Octokit } = require("@octokit/core");
const fetch = require("node-fetch");
const yaml = require("yaml");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const prNumber = process.env.PR_NUMBER;
const eventType = process.env.EVENT_TYPE;
const userMapURL = process.env.USER_MAP_URL;
const currentEventRemovedReviewer = process.env.REMOVED_REVIEWER;

const REMOVAL_TIME_WINDOW_MS = 2 * 60 * 1000;

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
        return info.notify === false ? `@${info.slack_id}>` : `<@${info.slack_id}>`;
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

async function getRecentlyUnassignedReviewers(prNumber, owner, repo, timeWindowMs) {
    const recentlyUnassigned = new Set();
    const now = new Date();
    for (let page = 1; page <= 3; page++) {
        const res = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
            page: page
        });

        if (res.data.length === 0) break;

        for (const event of res.data) {
            if (event.event === 'unassigned' && event.assignee && event.assignee.type === 'User') {
                const eventTime = new Date(event.created_at);
                if ((now.getTime() - eventTime.getTime()) <= timeWindowMs) {
                    recentlyUnassigned.add(event.assignee.login);
                }
            } else if (event.event === 'removed_from_review_queue' && event.actor) {
                const eventTime = new Date(event.created_at);
                if ((now.getTime() - eventTime.getTime()) <= timeWindowMs) {
                    recentlyUnassigned.add(event.actor.login);
                }
            }
        }
    }
    return recentlyUnassigned;
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

    let candidates = allUsers.filter(u => u !== author);
    const currentReviewers = pr.requested_reviewers.map(r => r.login);

    let excludedReviewersForMessage = [];

    if (eventType === "review_request_removed") {
        const recentlyUnassigned = await getRecentlyUnassignedReviewers(prNumber, owner, repo, REMOVAL_TIME_WINDOW_MS);
        if (currentEventRemovedReviewer) {
            recentlyUnassigned.add(currentEventRemovedReviewer);
        }

        if (recentlyUnassigned.size > 0) {
            console.log(`Excluding recently removed reviewers from candidate pool: ${Array.from(recentlyUnassigned).join(', ')}`);
            candidates = candidates.filter(u => !recentlyUnassigned.has(u));
            excludedReviewersForMessage = Array.from(recentlyUnassigned);
        }
    }

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
                    let msg = `🕵️ Reviewer update for PR #${prNumber} ${prLink} in \`${repo}\`: ${mention(addedReviewers, userMap)}.`;
                    if (eventType === "review_request_removed") {
                        const removedList = excludedReviewersForMessage.length > 0 ?
                            mention(excludedReviewersForMessage, userMap) : "reviewer(s)";
                        msg = `⚠️ ${removedList} removed from PR #${prNumber} ${prLink} in \`${repo}\`. Replaced by ${mention(addedReviewers, userMap)}.`;
                    }
                    await notifySlack(msg);
                }
            } else if (needed > 0 && available.length === 0) {
                const msg = `❗️ Reviewers needed for PR #${prNumber} ${prLink} in \`${repo}\` but no available candidates to assign.`;
                await notifySlack(msg);
            }
        } else if (eventType === "review_request_removed" && currentReviewers.length >= 2) {
            if (excludedReviewersForMessage.length > 0) {
                console.log(`Reviewer(s) ${excludedReviewersForMessage.join(', ')} removed from PR #${prNumber}, but enough reviewers (${currentReviewers.length}) still remain. No new assignment needed.`);
            } else {
                console.log(`Reviewer removed from PR #${prNumber}, but enough reviewers (${currentReviewers.length}) still remain. No new assignment needed.`);
            }
        }
    }
})();
