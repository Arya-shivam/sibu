/**
 * Opt-in execution evidence: load with `pi -e ./execution-recorder`.
 *
 * Stores schemaVersion 1 custom entries on the active session branch, not a
 * second transcript. By default only request digests, timing/status, output byte
 * counts and artifact path references are retained; never raw inputs, outputs,
 * or error messages. Artifact references are paths, not copies of their files.
 * Policy denial is evidence of a denied attempt, never evidence of execution.
 * Tool end events describe the raw execute result, before tool_result hooks.
 *
 * --record-inputs defaults to false. Explicitly enabling it includes redacted
 * final request snapshots. Redaction covers secret/auth/password/token keys,
 * common assignments, secret flags and authorization values, but cannot detect
 * arbitrary embedded secret literals. Existing session transcripts may already
 * contain sensitive inputs and outputs, independently of this recorder. Digests
 * are fingerprints, not encryption; low-entropy inputs may still be guessed.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { EVIDENCE_TYPE, type EvidenceRecord, readEvidence, recordExecution } from "./journal.ts";

function branchEvidence(ctx: ExtensionContext): EvidenceRecord[] {
	const records: EvidenceRecord[] = [];
	// getEntries() includes abandoned branches. Always read the current ancestry
	// afresh so resume, fork, tree navigation and session switch need no cache.
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== EVIDENCE_TYPE) continue;
		const record = readEvidence(entry.data);
		if (record) records.push(record);
	}
	return records;
}

export default function executionRecorder(pi: ExtensionAPI) {
	pi.registerFlag("record-inputs", {
		type: "boolean",
		default: false,
		description:
			"Include redacted final execution requests in evidence (may still contain embedded secrets; default false)",
	});

	// No open journal/file handles: evidence is persisted through the session API.
	// Await any admitted export before this extension instance is disposed.
	const exports = new Set<Promise<void>>();
	pi.registerCleanup(async () => {
		await Promise.allSettled([...exports]);
	});
	pi.on("execution", (event) => {
		pi.appendEntry(EVIDENCE_TYPE, recordExecution(event, pi.getFlag("record-inputs") === true));
	});

	pi.registerTool(
		defineTool({
			name: "execution_log",
			label: "Execution log",
			description:
				"Read execution evidence from the active session branch: list the latest records (default/max 50), inspect all phases of an execution by id, or export branch evidence as JSONL to path. Evidence describes raw execution, not transformed tool results; denied policy attempts were not started. Inputs are digest-only unless --record-inputs was enabled. Exports can contain sensitive opted-in snapshots and artifact paths.",
			executionMode: "sequential",
			parameters: Type.Object({
				action: StringEnum(["list", "inspect", "export"] as const),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, description: "Latest records for list (default 50)" }),
				),
				id: Type.Optional(Type.String({ minLength: 1, description: "Execution id for inspect" })),
				path: Type.Optional(
					Type.String({ minLength: 1, description: "JSONL destination for export, relative to cwd or absolute" }),
				),
			}),
			async execute(_id, params, signal, _update, ctx) {
				signal?.throwIfAborted();
				const records = branchEvidence(ctx);
				if (params.action === "export") {
					if (!params.path?.trim()) throw new Error("execution_log export requires path");
					const path = resolve(ctx.cwd, params.path);
					// Capture only this branch at invocation, before joining the path's
					// shared mutation queue. Never re-read a different session after await.
					const jsonl = records.map((record) => JSON.stringify(record)).join("\n");
					const operation = withFileMutationQueue(path, async () => {
						signal?.throwIfAborted();
						await writeFile(path, jsonl ? `${jsonl}\n` : "", { encoding: "utf8", mode: 0o600 });
					});
					exports.add(operation);
					try {
						await operation;
					} finally {
						exports.delete(operation);
					}
					return {
						content: [{ type: "text", text: `Exported ${records.length} execution evidence records to ${path}` }],
						details: { action: params.action, count: records.length, artifactPath: path },
					};
				}
				if (params.action === "inspect" && !params.id) throw new Error("execution_log inspect requires id");
				const selected =
					params.action === "inspect"
						? records.filter((record) => record.executionId === params.id)
						: records.slice(-Math.min(50, Math.max(1, params.limit ?? 50)));
				const text = JSON.stringify(selected, null, 2);
				const bounded = truncateHead(text);
				let fullOutputPath: string | undefined;
				if (bounded.truncated) {
					fullOutputPath = join(await mkdtemp(join(tmpdir(), "pi-execution-evidence-")), "records.json");
					await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
				}
				return {
					content: [
						{
							type: "text",
							text: bounded.content + (fullOutputPath ? `\nFull evidence: ${fullOutputPath}` : ""),
						},
					],
					details: { action: params.action, count: selected.length, fullOutputPath },
				};
			},
		}),
	);
}
