import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	defineTool,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { canonicalPath, hashBytes, MAX_FILES, type ManifestEntry, snapshotInputs } from "./snapshot.ts";

interface Check {
	id: string;
	command: string;
	args: string[];
	files: string[];
	cwd?: string;
	timeout?: number;
}

interface Configuration {
	checks: Check[];
	hash: string;
}

type Outcome = "passed" | "failed" | "cancelled" | "denied" | "changed_during_check";

export interface VerificationEvidence {
	schemaVersion: 1;
	id: string;
	workspaceRoot: string;
	configHash: string | null;
	manifest: ManifestEntry[];
	manifestHash: string | null;
	startedAt: number;
	finishedAt: number;
	outcome: Outcome;
	exitCode: number | null;
	killed: boolean | null;
	artifacts: { stdout?: string; stderr?: string };
	error?: string;
	errorHash?: string;
}

interface VerificationStatus {
	id: string;
	state: Outcome | "stale" | "not_run";
	reason?: string;
	record?: VerificationEvidence;
}

interface VerificationDetails {
	record?: VerificationEvidence;
	statuses?: VerificationStatus[];
}

const ENTRY_TYPE = "verification-evidence";
const NOTICE = "[Verification freshness notice]";
const OUTPUT_LIMITS = { maxBytes: 12 * 1024, maxLines: 160 };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && !item.includes("\0"));
}

async function loadConfiguration(pi: ExtensionAPI, workspaceRoot: string): Promise<Configuration> {
	const flag = pi.getFlag("verification-config");
	if (typeof flag !== "string" || !flag.trim())
		throw new Error("Pass --verification-config /path/to/trusted.json; no checks are inferred or installed.");
	const bytes = await readFile(resolve(workspaceRoot, flag));
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (!isObject(value) || !Array.isArray(value.checks)) throw new Error("Verification config requires checks: [...].");
	const checks: Check[] = [];
	const ids = new Set<string>();
	for (const item of value.checks) {
		if (
			!isObject(item) ||
			typeof item.id !== "string" ||
			!item.id.trim() ||
			item.id.includes("\0") ||
			typeof item.command !== "string" ||
			!item.command.trim() ||
			item.command.includes("\0") ||
			!stringList(item.args) ||
			!stringList(item.files) ||
			item.files.length === 0 ||
			item.files.some((file) => !file.trim())
		) {
			throw new Error(
				"Every verification check requires id, command, args: string[], and nonempty files: string[].",
			);
		}
		if (item.files.length > MAX_FILES) throw new Error(`Check ${item.id} exceeds the 256-file limit.`);
		if (ids.has(item.id)) throw new Error(`Duplicate verification check id: ${item.id}`);
		if (item.cwd !== undefined && (typeof item.cwd !== "string" || !item.cwd.trim() || item.cwd.includes("\0")))
			throw new Error(`Check ${item.id}: cwd must be a nonempty path.`);
		if (
			item.timeout !== undefined &&
			(typeof item.timeout !== "number" || !Number.isSafeInteger(item.timeout) || item.timeout <= 0)
		)
			throw new Error(`Check ${item.id}: timeout must be a positive integer in milliseconds.`);
		ids.add(item.id);
		checks.push({
			id: item.id,
			command: item.command,
			args: item.args,
			files: item.files,
			cwd: item.cwd,
			timeout: item.timeout,
		});
	}
	return { checks, hash: hashBytes(bytes) };
}

function isEvidence(value: unknown): value is VerificationEvidence {
	if (!isObject(value)) return false;
	return (
		value.schemaVersion === 1 &&
		typeof value.id === "string" &&
		typeof value.workspaceRoot === "string" &&
		(value.configHash === null || typeof value.configHash === "string") &&
		Array.isArray(value.manifest) &&
		value.manifest.length <= MAX_FILES &&
		value.manifest.every(
			(entry: unknown) =>
				isObject(entry) &&
				typeof entry.path === "string" &&
				typeof entry.hash === "string" &&
				typeof entry.bytes === "number",
		) &&
		(value.manifestHash === null || typeof value.manifestHash === "string") &&
		typeof value.startedAt === "number" &&
		typeof value.finishedAt === "number" &&
		["passed", "failed", "cancelled", "denied", "changed_during_check"].includes(String(value.outcome)) &&
		(value.exitCode === null || typeof value.exitCode === "number") &&
		(value.killed === null || typeof value.killed === "boolean") &&
		isObject(value.artifacts) &&
		(value.artifacts.stdout === undefined || typeof value.artifacts.stdout === "string") &&
		(value.artifacts.stderr === undefined || typeof value.artifacts.stderr === "string") &&
		(value.error === undefined || typeof value.error === "string") &&
		(value.errorHash === undefined || typeof value.errorHash === "string")
	);
}

/** Reconstruct on every query: off-branch attempts must never authorize a pass. */
function latestEvidence(ctx: ExtensionContext): Map<string, VerificationEvidence> {
	const latest = new Map<string, VerificationEvidence>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isEvidence(entry.data))
			latest.set(entry.data.id, entry.data);
	}
	return latest;
}

function errorText(error: unknown): string {
	return truncateHead(error instanceof Error ? error.message : String(error), { maxBytes: 2048, maxLines: 12 })
		.content;
}

async function getStatuses(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	checkId?: string,
	signal?: AbortSignal,
): Promise<VerificationStatus[]> {
	const latest = latestEvidence(ctx);
	let workspaceRoot = resolve(ctx.cwd);
	let configuration: Configuration | undefined;
	let configError: string | undefined;
	try {
		signal?.throwIfAborted();
		workspaceRoot = await canonicalPath(ctx.cwd);
		configuration = await loadConfiguration(pi, workspaceRoot);
	} catch (error) {
		if (signal?.aborted) throw error;
		configError = errorText(error);
	}
	if (configError && latest.size === 0) throw new Error(configError);
	const ids =
		checkId === undefined
			? new Set([...latest.keys(), ...(configuration?.checks.map((check) => check.id) ?? [])])
			: new Set([checkId]);
	const statuses: VerificationStatus[] = [];
	for (const id of ids) {
		signal?.throwIfAborted();
		const record = latest.get(id);
		const check = configuration?.checks.find((candidate) => candidate.id === id);
		if (!record) {
			statuses.push({
				id,
				state: "not_run",
				reason: configError ?? (check ? undefined : "Check is not configured."),
			});
			continue;
		}
		if (record.outcome !== "passed") {
			statuses.push({ id, state: record.outcome, record });
			continue;
		}
		let reason = configError;
		if (!reason && record.workspaceRoot !== workspaceRoot) reason = "Workspace root changed.";
		if (!reason && record.configHash !== configuration?.hash) reason = "Verification config changed.";
		if (!reason && !check) reason = "Check is no longer configured.";
		if (!reason && check) {
			try {
				const current = await snapshotInputs(check.files, workspaceRoot, signal);
				if (
					current.manifestHash !== record.manifestHash ||
					JSON.stringify(current.manifest) !== JSON.stringify(record.manifest)
				)
					reason = "Configured input files changed.";
			} catch (error) {
				if (signal?.aborted) throw error;
				reason = `Configured inputs are unavailable: ${errorText(error)}`;
			}
		}
		statuses.push({ id, state: reason ? "stale" : "passed", reason, record });
	}
	return statuses;
}

async function preserveOutput(result: ExecResult, record: VerificationEvidence): Promise<void> {
	const output = JSON.stringify({ stdout: result.stdout, stderr: result.stderr });
	if (!truncateHead(output, { maxBytes: 8 * 1024, maxLines: 100 }).truncated) return;
	const directory = await mkdtemp(join(tmpdir(), "pi-verification-"));
	const stdout = join(directory, "stdout.txt");
	const stderr = join(directory, "stderr.txt");
	await writeFile(stdout, result.stdout);
	record.artifacts.stdout = stdout;
	await writeFile(stderr, result.stderr);
	record.artifacts.stderr = stderr;
}

function runText(record: VerificationEvidence, result?: ExecResult, failureDetail?: string): string {
	const summary = JSON.stringify(
		{
			id: record.id,
			outcome: record.outcome,
			scope: { files: record.manifest.length, manifestHash: record.manifestHash },
			exitCode: record.exitCode,
			killed: record.killed,
			error: failureDetail ?? record.error,
			stdout: result?.stdout,
			stderr: result?.stderr,
		},
		null,
		2,
	);
	const bounded = truncateHead(summary, OUTPUT_LIMITS);
	return (
		bounded.content +
		(record.artifacts.stdout ? `\nFull stdout: ${record.artifacts.stdout}` : "") +
		(record.artifacts.stderr ? `\nFull stderr: ${record.artifacts.stderr}` : "") +
		"\nOutput and temporary artifacts may contain secrets. Evidence covers only the explicitly configured files; it is not a universal regression-free claim."
	);
}

async function runCheck(pi: ExtensionAPI, ctx: ExtensionContext, id: string | undefined, signal?: AbortSignal) {
	const record: VerificationEvidence = {
		schemaVersion: 1,
		id: id ?? "(missing check)",
		workspaceRoot: resolve(ctx.cwd),
		configHash: null,
		manifest: [],
		manifestHash: null,
		startedAt: Date.now(),
		finishedAt: 0,
		outcome: "failed",
		exitCode: null,
		killed: null,
		artifacts: {},
	};
	let result: ExecResult | undefined;
	let failureDetail: string | undefined;
	try {
		signal?.throwIfAborted();
		if (!id) throw new Error("verify run requires check: configured check id.");
		record.workspaceRoot = await canonicalPath(ctx.cwd);
		const configuration = await loadConfiguration(pi, record.workspaceRoot);
		record.configHash = configuration.hash;
		const check = configuration.checks.find((candidate) => candidate.id === id);
		if (!check) throw new Error(`Unknown configured verification check: ${id}`);
		const before = await snapshotInputs(check.files, record.workspaceRoot, signal);
		record.manifest = before.manifest;
		record.manifestHash = before.manifestHash;
		const cwd = await canonicalPath(resolve(record.workspaceRoot, check.cwd ?? "."));
		if (!(await stat(cwd)).isDirectory()) throw new Error("Verification cwd must be a directory.");
		// pi.exec supplies the final execution_guard boundary; never spawn around it.
		result = await pi.exec(check.command, check.args, { cwd, timeout: check.timeout, signal });
		record.exitCode = result.code;
		record.killed = result.killed;
		await preserveOutput(result, record);
		signal?.throwIfAborted();
		if (result.killed) {
			record.outcome = "cancelled";
			record.error = "Verification process was killed (timeout or cancellation); no pass recorded.";
		} else {
			try {
				const after = await snapshotInputs(check.files, record.workspaceRoot, signal);
				if (JSON.stringify(before.manifest) !== JSON.stringify(after.manifest)) {
					record.outcome = "changed_during_check";
					record.error = "Configured input manifest changed during the check.";
				} else {
					record.outcome = result.code === 0 ? "passed" : "failed";
					if (result.code !== 0) record.error = `Verification process exited with code ${result.code}.`;
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				record.outcome = "changed_during_check";
				failureDetail = errorText(error);
				record.error = "Cannot establish unchanged inputs after the check.";
				record.errorHash = hashBytes(error instanceof Error ? error.message : String(error));
			}
		}
	} catch (error) {
		failureDetail = errorText(error);
		record.errorHash = hashBytes(error instanceof Error ? error.message : String(error));
		record.outcome = signal?.aborted
			? "cancelled"
			: failureDetail.startsWith("Execution blocked by execution_guard")
				? "denied"
				: "failed";
		record.error =
			record.outcome === "cancelled"
				? "Verification attempt was cancelled."
				: record.outcome === "denied"
					? "Verification execution was denied by an execution guard."
					: "Verification attempt failed; inspect the tool error output.";
	}
	record.finishedAt = Date.now();
	// Even pre-execution errors supersede an older pass for this check on this branch.
	pi.appendEntry<VerificationEvidence>(ENTRY_TYPE, record);
	const text = runText(record, result, failureDetail);
	if (record.outcome !== "passed") throw new Error(text);
	return { content: [{ type: "text" as const, text }], details: { record } };
}

export default function verification(pi: ExtensionAPI) {
	pi.registerFlag("verification-config", {
		type: "string",
		description: "Trusted JSON configured checks; commands run with Pi's permissions, not in a sandbox",
	});
	pi.on("context_with_system", async (event, ctx) => {
		if (![...latestEvidence(ctx).values()].some((record) => record.outcome === "passed")) return;
		const stale = (await getStatuses(pi, ctx, undefined, ctx.signal)).filter((status) => status.state === "stale");
		if (stale.length === 0) return;
		const summary = truncateHead(
			stale
				.slice(0, 16)
				.map((status) => `${JSON.stringify(status.id)}: ${status.reason}`)
				.join("\n"),
			{ maxBytes: 4096, maxLines: 32 },
		).content;
		return {
			messages: [
				...event.messages.filter(
					(message) =>
						!(
							message.role === "user" &&
							typeof message.content === "string" &&
							message.content.startsWith(NOTICE)
						),
				),
				{
					role: "user" as const,
					content:
						`${NOTICE}\nPrevious configured passes are stale:\n${summary}` +
						(stale.length > 16 ? `\n${stale.length - 16} additional stale checks.` : "") +
						"\nUse verify run for fresh evidence. Evidence covers only each check's explicit files, not all possible regressions.",
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.registerTool(
		defineTool({
			name: "verify",
			label: "Configured verification",
			description:
				"Run an explicit trusted check or rehash active-branch evidence. Requires --verification-config JSON {checks:[{id,command,args,files,cwd?,timeout?}]}. files are required literal regular-file paths relative to workspace root (or absolute), not globs; cwd only changes command working directory. Limits: 256 files, 8 MiB each, 64 MiB total. timeout is milliseconds. A pass requires exit 0, not killed, and identical raw-byte SHA-256 manifests before/after. Only this explicit input scope is verified; not a universal regression-free claim. Status checks current bytes, config and workspace; it never runs commands.",
			executionMode: "sequential",
			parameters: Type.Object({
				action: StringEnum(["run", "status"] as const),
				check: Type.Optional(Type.String({ minLength: 1, description: "Configured check id; required for run" })),
			}),
			async execute(_id, params, signal, _update, ctx): Promise<AgentToolResult<VerificationDetails>> {
				if (params.action === "run") return runCheck(pi, ctx, params.check, signal);
				const statuses = await getStatuses(pi, ctx, params.check, signal);
				const summary = statuses.map(({ id, state, reason, record }) => ({
					id,
					state,
					reason,
					finishedAt: record?.finishedAt,
					scope: record ? { files: record.manifest.length, manifestHash: record.manifestHash } : undefined,
				}));
				const text = truncateHead(JSON.stringify({ statuses: summary }, null, 2), OUTPUT_LIMITS).content;
				return { content: [{ type: "text" as const, text }], details: { statuses } };
			},
		}),
	);
}
