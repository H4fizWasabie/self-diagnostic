// Personal extension: after a task settles, scan this session's transcript for
// signs theoses got stuck or broke a standing rule, and file a GitHub issue so
// the pattern gets reviewed instead of silently repeating.
//
// Phase A of the self-eval watcher (idea: ~/idea-folder/2026-09-18-self-eval-watcher.md).
// Checks:
//   1. repeated-bash-failure  — same bash command failed >=3 times in a row with no edit/write between
//   2. error-retry-streak     — >=3 consecutive assistant turns ended stopReason "error"
//   3. gate-breach            — Edit/Write into theoses2 source with no gh issue/pr create
//                               anywhere in the session (warn-only: needs human review)
//   4. procura-via-bash       — bash touching sqlite+procura (should have used procura tools)
// (A fifth check, unsupported-completion-claim, was removed 2026-09-19: the 45 rows it recorded were 10
// distinct events and none was a real false claim; a "done" keyword plus a non-zero exit code, which is
// normal for grep with no matches, flagged correct reports. Backup: self-diagnostic.ts.bak-pre-claim-off-20260919.)
//
// Jev shadow mode: each finding gets one Noul "worth filing?" call; the verdict is
// logged to a JSONL shadow log and annotated on the issue, but does NOT gate filing.
// Calibrate against outcomes before letting it gate (same discipline as memory
// consolidation, where Jev confidence proved non-predictive).
//
// Scope (fixed 2026-09-19): checks run over the CURRENT TASK only (from the last user message on),
// not the whole session file. The Telegram session is one file spanning days, so whole-session
// scans re-found the same stale failures after every restart and made gate-breach unfireable.
// Each (session, task, kind, key) is evaluated once; seen fingerprints persist in
// self-diagnostic-state.json so restarts don't re-scan or re-spend Jev calls.
//
// Reads only what theoses already persists (session entries via ctx.sessionManager) -
// no new logging of the session itself, no live event accumulation, no backfill.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "theoses-coding-agent";

const ISSUE_LABEL = "theoses-self-diagnostic";
const MIN_REPEATED_FAILURES = 3;
const MIN_ERROR_STREAK = 3;
const MAX_JEV_SHADOW_CALLS = 4;
// Theoses runs across many projects/workspaces; diagnostics about its own
// behavior always go to its own repo, not whatever repo the session's cwd happens to be in.
const TARGET_REPO = "H4fizWasabie/theoses2";
// Directories that count as "theoses2 source" for the review-gate check.
const THEOSES2_SOURCE_DIRS = ["/home/theoses/icm-workspaces/theoses2", "/opt/theoses2-releases"];
const JEVS_SHADOW_LOG = "/home/theoses/.theoses/agent/self-diagnostic-jev-shadow.jsonl";
const STATE_FILE = "/home/theoses/.theoses/agent/self-diagnostic-state.json";
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// A gh issue/pr created up to this long before an edit still counts as that edit's review gate
// (a "Go" turn follows the turn that opened the PR).
const GATE_EVIDENCE_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_OPEN_ISSUES_IN_JEV_STATE = 15;

type Finding = {
	kind:
		| "repeated-bash-failure"
		| "error-retry-streak"
		| "gate-breach"
		| "procura-via-bash";
	summary: string;
	detail: string;
	/** Stable identity within a task (command, error text, path...) for once-only evaluation. */
	key: string;
};

type AnyMessage = Record<string, any>;
type SessionEntryLike = { type: string; timestamp?: string; message?: AnyMessage };

// Creating (not just viewing) an issue or PR is what satisfies the review gate.
const GH_GATE_RE = /gh\s+(issue|pr)\s+create/;

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function contentText(message: AnyMessage): string {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text ?? "")
		.join("\n");
}

const FILE_CHANGING_TOOLS = new Set(["edit", "write", "multiedit"]);

// Counts failures of the same command only while nothing changed in between: an edit/write resets every
// streak, and a success resets that command's streak. Issue #407 (2026-09-28) was a normal fix-and-rerun
// loop - the same verify command failed three times with an edit before each rerun - and got filed as
// "stuck"; what this check exists for is rerunning a failing command unchanged.
export function findRepeatedBashFailures(messages: AnyMessage[]): Finding[] {
	const results = new Map<string, AnyMessage>();
	for (const m of messages) if (m?.role === "toolResult") results.set(m.toolCallId, m);

	const streaks = new Map<string, number>();
	const worst = new Map<string, { count: number; lastError: string }>();

	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			if (item?.type !== "toolCall") continue;
			if (FILE_CHANGING_TOOLS.has(item.name)) {
				streaks.clear();
				continue;
			}
			if (item.name !== "bash") continue;
			const command = typeof item.arguments?.command === "string" ? item.arguments.command : undefined;
			const result = results.get(item.id);
			if (!command || !result) continue;

			const key = normalizeCommand(command);
			if (!result.isError) {
				streaks.delete(key);
				continue;
			}
			const count = (streaks.get(key) ?? 0) + 1;
			streaks.set(key, count);
			if (count >= (worst.get(key)?.count ?? 0)) {
				worst.set(key, { count, lastError: contentText(result).slice(-500) });
			}
		}
	}

	const findings: Finding[] = [];
	for (const [command, { count, lastError }] of worst) {
		if (count < MIN_REPEATED_FAILURES) continue;
		findings.push({
			kind: "repeated-bash-failure",
			key: command,
			summary: `Bash command failed ${count} times in a row with no edits in between: \`${command}\``,
			detail: `Command:\n\`\`\`\n${command}\n\`\`\`\n\nFailed ${count} times in a row with no file edits in between. Last error output:\n\`\`\`\n${lastError}\n\`\`\``,
		});
	}
	return findings;
}

function findErrorRetryStreaks(messages: AnyMessage[]): Finding[] {
	let streak = 0;
	let maxStreak = 0;
	let lastErrorMessage = "";
	for (const message of messages) {
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") {
			streak += 1;
			lastErrorMessage = message.errorMessage ?? lastErrorMessage;
			maxStreak = Math.max(maxStreak, streak);
		} else {
			streak = 0;
		}
	}

	if (maxStreak < MIN_ERROR_STREAK) return [];
	return [
		{
			kind: "error-retry-streak",
			key: lastErrorMessage || "error-streak",
			summary: `${maxStreak} consecutive assistant turns ended with stopReason "error"`,
			detail: `Longest consecutive error streak: ${maxStreak}\nLast error message: ${lastErrorMessage || "(none captured)"}`,
		},
	];
}

// Gate breach = an Edit/Write tool call whose path lives under a theoses2 source dir,
// with no "gh issue create" or "gh pr create" command anywhere in the session.
// Warn-only for now: filed with a warning banner, not auto-trusted as a violation.
function findGateBreaches(messages: AnyMessage[], recentGhGate: boolean): Finding[] {
	let editedTheoses2 = false;
	let sampleEdit = "";
	let usedGhGate = recentGhGate;

	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			if (item?.type !== "toolCall") continue;
			if (item.name === "edit" || item.name === "write" || item.name === "multiedit") {
				const path = typeof item.arguments?.path === "string" ? item.arguments.path : "";
				if (path && THEOSES2_SOURCE_DIRS.some((dir) => path.startsWith(dir))) {
					editedTheoses2 = true;
					if (!sampleEdit) sampleEdit = path;
				}
			}
			if (item.name === "bash") {
				const command = typeof item.arguments?.command === "string" ? item.arguments.command : "";
				if (GH_GATE_RE.test(command)) usedGhGate = true;
			}
		}
	}

	if (!editedTheoses2 || usedGhGate) return [];
	return [
		{
			kind: "gate-breach",
			key: sampleEdit,
			summary: `Possible review-gate breach: edited theoses2 source with no issue/PR in session`,
			detail: `WARN-ONLY: needs human review — this may be legitimate (e.g. the gate was satisfied in another session, or the edit is exempt).\n\nEdited file(s) under theoses2 source dirs. First seen: \`${sampleEdit}\`\nNo \`gh issue create\` / \`gh pr create\` command found in this task or in the 6 hours before it.`,
		},
	];
}

// Bash touching both "sqlite" and "procura" should have gone through the procura
// extension tools (standing rule 2026-09-11). mode=ro bypasses are allowed as a
// last resort but must be stated; the finding notes whether mode=ro was present.
function findProcuraViaBash(messages: AnyMessage[]): Finding[] {
	const offenders = new Map<string, { count: number; hadModeRo: boolean }>();
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			if (item?.type !== "toolCall" || item.name !== "bash") continue;
			const command = typeof item.arguments?.command === "string" ? item.arguments.command : "";
			if (!/sqlite/i.test(command) || !/procura/i.test(command)) continue;
			const key = normalizeCommand(command);
			const prior = offenders.get(key);
			offenders.set(key, {
				count: (prior?.count ?? 0) + 1,
				hadModeRo: (prior?.hadModeRo ?? false) || /mode=ro/.test(command),
			});
		}
	}

	if (offenders.size === 0) return [];
	const sample = [...offenders.entries()][0]!;
	const allRo = [...offenders.values()].every((v) => v.hadModeRo);
	return [
		{
			kind: "procura-via-bash",
			key: sample[0],
			summary: `Raw sqlite/bash used against the Procura DB instead of procura tools (${offenders.size} distinct command(s))`,
			detail: `Standing rule 2026-09-11: Procura questions go through procura extension tools first; raw bash/sqlite is last resort with mode=ro and a stated bypass reason.\n\nFirst command:\n\`\`\`\n${sample[0]}\n\`\`\`\nmode=ro present: ${sample[1].hadModeRo ? "yes" : "NO"} (all offenders mode=ro: ${allRo ? "yes" : "no"}). If the bypass reason was stated in the reply, this finding can be closed as legitimate.`,
		},
	];
}

// --- Jev shadow filter ---------------------------------------------------------

async function askJevNoulShadow(
	state: Record<string, string>,
): Promise<{ probability?: number; error?: string; model?: string; latencyMs?: number }> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return { error: "no OPENROUTER_API_KEY in env" };
	const started = Date.now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15_000);
		const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "~typesafe/jev-latest",
				state,
				questions: {
					answer: {
						type: "noul",
						instructions:
							"Is this finding a real, actionable problem worth filing as a GitHub issue for review — rather than a known-benign pattern, a duplicate of one of the `open_issues`, or a false positive of the detector?",
					},
				},
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		const latencyMs = Date.now() - started;
		if (!response.ok) return { error: `HTTP ${response.status}`, latencyMs };
		const body = (await response.json()) as any;
		const probability = typeof body?.answers?.answer?.noul === "number" ? body.answers.answer.noul : undefined;
		return { probability, model: body?.model, latencyMs };
	} catch (error: any) {
		return { error: String(error?.message ?? error), latencyMs: Date.now() - started };
	}
}

function appendShadowLog(entry: Record<string, unknown>): void {
	try {
		appendFileSync(JEVS_SHADOW_LOG, `${JSON.stringify(entry)}\n`);
	} catch {
		// shadow logging must never break the extension
	}
}

// --- issue filing ---------------------------------------------------------------

type SeenState = Record<string, string>; // fingerprint -> ISO time first evaluated

function loadSeen(): SeenState {
	try {
		if (!existsSync(STATE_FILE)) return {};
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { seen?: SeenState };
		const cutoff = Date.now() - STATE_RETENTION_MS;
		return Object.fromEntries(Object.entries(raw.seen ?? {}).filter(([, ts]) => Date.parse(ts) >= cutoff));
	} catch {
		return {}; // corrupt state must never break the extension; worst case one task is re-evaluated
	}
}

function saveSeen(seen: SeenState): void {
	try {
		writeFileSync(STATE_FILE, JSON.stringify({ seen }, null, 0));
	} catch {
		// non-fatal
	}
}

function fingerprint(sessionId: string, taskId: string, finding: Finding): string {
	return createHash("sha1").update(`${sessionId}|${taskId}|${finding.kind}|${finding.key}`).digest("hex").slice(0, 16);
}

/** Entries of the current task: from the last user message to the end. Falls back to everything
 * when the session has no user message (e.g. a purely scheduled run). Returns the anchor's id so a
 * task is identified even though its messages carry no ids of their own. */
function currentTask(entries: SessionEntryLike[] & { id?: string }[]): { messages: AnyMessage[]; taskId: string } {
	const msgEntries = (entries as any[]).filter((e) => e.type === "message");
	let start = 0;
	for (let i = msgEntries.length - 1; i >= 0; i--) {
		if (msgEntries[i].message?.role === "user") {
			start = i;
			break;
		}
	}
	const slice = msgEntries.slice(start);
	return { messages: slice.map((e) => e.message), taskId: String(slice[0]?.id ?? "no-anchor") };
}

/** True when a gh issue/pr create ran in the current task or in the window before it. */
function hasRecentGhGate(entries: any[], taskStartTs: number): boolean {
	const since = taskStartTs - GATE_EVIDENCE_WINDOW_MS;
	for (const e of entries) {
		if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
		if (Date.parse(e.timestamp ?? "") < since) continue;
		for (const item of e.message.content) {
			if (item?.type === "toolCall" && item.name === "bash" && GH_GATE_RE.test(String(item.arguments?.command ?? ""))) return true;
		}
	}
	return false;
}

async function listOpenIssueTitles(theoses: ExtensionAPI, repo: string, cwd: string): Promise<string[]> {
	const result = await theoses.exec(
		"gh",
		["issue", "list", "--repo", repo, "--label", ISSUE_LABEL, "--state", "open", "--json", "title", "--limit", "50"],
		{ cwd, timeout: 10_000 },
	);
	if (result.code !== 0) return [];
	try {
		return (JSON.parse(result.stdout) as { title: string }[]).map((issue) => issue.title);
	} catch {
		return [];
	}
}

export default function (theoses: ExtensionAPI) {
	theoses.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const sm = ctx.sessionManager;
		if (!sm) return;
		const sessionId = sm.getSessionId();
		const entries = sm.getEntries() as any[];
		const { messages, taskId } = currentTask(entries);
		if (messages.length === 0) return;

		const taskStartTs = Date.parse(entries.find((e) => e.id === taskId)?.timestamp ?? "") || Date.now();
		const findings = [
			...findRepeatedBashFailures(messages),
			...findErrorRetryStreaks(messages),
			...findGateBreaches(messages, hasRecentGhGate(entries, taskStartTs)),
			...findProcuraViaBash(messages),
		];
		if (findings.length === 0) return;

		// Once-only per (session, task, kind, key), remembered across restarts.
		const seen = loadSeen();
		const fresh = findings.filter((f) => !seen[fingerprint(sessionId, taskId, f)]);
		if (fresh.length === 0) return;
		const now = new Date().toISOString();
		for (const f of fresh) seen[fingerprint(sessionId, taskId, f)] = now;
		saveSeen(seen);

		const repo = TARGET_REPO;
		const openTitles = await listOpenIssueTitles(theoses, repo, ctx.cwd);
		// Per-finding dedup: a finding whose own title is already open is dropped, so an old open
		// issue can no longer swallow unrelated new findings that happen to share a task with it.
		const titleOf = (f: Finding) => `[self-diagnostic] ${f.summary}`;
		const toFile = fresh.filter((f) => !openTitles.includes(titleOf(f)));
		if (toFile.length === 0) return;

		// Jev shadow: annotate each finding with a worth-filing probability. Does NOT gate filing —
		// calibration data first. Jev is given the open issue titles so "duplicate" is answerable.
		const openIssuesState = openTitles
			.slice(0, MAX_OPEN_ISSUES_IN_JEV_STATE)
			.map((t) => t.slice(0, 100))
			.join(" | ");
		const shadow: { finding: Finding; verdict: Awaited<ReturnType<typeof askJevNoulShadow>> }[] = [];
		for (const finding of toFile.slice(0, MAX_JEV_SHADOW_CALLS)) {
			const verdict = await askJevNoulShadow({
				kind: finding.kind,
				summary: finding.summary,
				detail: finding.detail.slice(0, 2000),
				session_cwd: ctx.cwd,
				open_issues: openIssuesState || "(none)",
			});
			shadow.push({ finding, verdict });
		}
		const shadowVerdicts = shadow.map(
			({ finding, verdict }) =>
				`${finding.kind}: ${verdict.error ? `jev-error (${verdict.error})` : `worth-filing=${verdict.probability?.toFixed(2) ?? "?"}`}`,
		);
		if (toFile.length > MAX_JEV_SHADOW_CALLS) {
			shadowVerdicts.push(`(Jev shadow skipped for ${toFile.length - MAX_JEV_SHADOW_CALLS} finding(s): cap ${MAX_JEV_SHADOW_CALLS})`);
		}

		const title = `${titleOf(toFile[0]!)}${toFile.length > 1 ? ` (+${toFile.length - 1} more)` : ""}`;
		const body = [
			`Session: \`${sessionId}\``,
			`Task anchor: \`${taskId}\``,
			`Working directory: \`${ctx.cwd}\``,
			`Detected ${toFile.length} new issue(s) in the last task:`,
			"",
			...toFile.map((f) => `### ${f.kind}\n\n${f.detail}`),
			"",
			"### Jev shadow verdicts (not gating)",
			...shadowVerdicts.map((v) => `- ${v}`),
		].join("\n");

		const result = await theoses.exec(
			"gh",
			["issue", "create", "--repo", repo, "--title", title, "--body", body, "--label", ISSUE_LABEL],
			{ cwd: ctx.cwd, timeout: 15_000 },
		);
		const issueUrl = result.code === 0 ? result.stdout.trim() : undefined;

		// Log after filing so each verdict carries what it was judged on and where it ended up —
		// calibration needs (summary, probability, outcome), not just (kind, probability).
		for (const { finding, verdict } of shadow) {
			appendShadowLog({
				ts: now,
				sessionId,
				taskId,
				finding: finding.kind,
				summary: finding.summary.slice(0, 200),
				fingerprint: fingerprint(sessionId, taskId, finding),
				filed: Boolean(issueUrl),
				issueUrl,
				...verdict,
			});
		}

		if (issueUrl) ctx.ui.notify(`Filed self-diagnostic issue: ${issueUrl}`, "info");
	});
}
