import { createHash } from "node:crypto";
import type { ExecutionEvent, ExecutionRequest } from "@earendil-works/pi-coding-agent";

export const EVIDENCE_TYPE = "execution-evidence";
const REDACTED = "[REDACTED]";
const SECRET_KEY = /secret|auth|password|passwd|token|credential|api[-_]?key|private[-_]?key|cookie/i;
const SECRET_NAME =
	"[\\w.-]*(?:secret|auth|password|passwd|token|credential|api[-_]?key|private[-_]?key|cookie)[\\w.-]*";
const SECRET_ASSIGNMENT = new RegExp(`(\\b${SECRET_NAME}\\s*=\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s;|&]+)`, "gi");
const SECRET_OPTION = new RegExp(`(--?${SECRET_NAME}(?:=|\\s+))(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s;|&]+)`, "gi");

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ResultSummary {
	code?: number | null;
	killed?: boolean;
	cancelled?: boolean;
	isError?: boolean;
	truncated?: boolean;
	stdoutBytes?: number;
	stderrBytes?: number;
	outputBytes?: number;
	contentBytes?: number;
	artifactPaths?: string[];
}

export interface EvidenceRecord {
	schemaVersion: 1;
	executionId: string;
	phase: ExecutionEvent["phase"];
	kind: ExecutionRequest["kind"];
	toolName?: string;
	timestamp: number;
	durationMs?: number;
	outcome?: ExecutionEvent["outcome"];
	inputHash: string;
	error: { present: boolean; hash?: string; bytes?: number };
	result?: ResultSummary;
	request?: JsonValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Canonicalize only the final request, never session messages or result bodies. */
function serializable(value: unknown, ancestors = new Set<object>()): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value !== "object") return `[${typeof value}:${String(value)}]`;
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item: unknown) => serializable(item, ancestors));
		const result: Record<string, JsonValue> = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			const field: unknown = Reflect.get(value, key);
			if (field === undefined) continue;
			result[key] = serializable(field, ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function redactText(value: string): string {
	return value
		.replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
		.replace(SECRET_OPTION, `$1${REDACTED}`)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, `$1 ${REDACTED}`);
}

function redact(value: JsonValue): JsonValue {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) {
		let secretValue = false;
		return value.map((item) => {
			if (secretValue) {
				secretValue = false;
				return REDACTED;
			}
			if (typeof item === "string" && /^--?[^=\s]+$/.test(item) && SECRET_KEY.test(item)) {
				secretValue = true;
				return item;
			}
			return redact(item);
		});
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, JsonValue> = Object.create(null);
		for (const [key, item] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? REDACTED : redact(item);
		return result;
	}
	return value;
}

function summarizeResult(value: unknown): ResultSummary | undefined {
	if (!isObject(value)) return undefined;
	const summary: ResultSummary = {};
	const code = value.code !== undefined ? value.code : value.exitCode;
	if (code === null || (typeof code === "number" && Number.isFinite(code))) summary.code = code;
	for (const key of ["killed", "cancelled", "isError", "truncated"] as const) {
		if (typeof value[key] === "boolean") summary[key] = value[key];
	}
	let outputBytes = 0;
	let hasOutput = false;
	for (const key of ["stdout", "stderr", "output"] as const) {
		const text = value[key];
		if (typeof text !== "string") continue;
		const bytes = Buffer.byteLength(text, "utf8");
		if (key === "stdout") summary.stdoutBytes = bytes;
		if (key === "stderr") summary.stderrBytes = bytes;
		outputBytes += bytes;
		hasOutput = true;
	}
	if (Array.isArray(value.content)) {
		let bytes = 0;
		for (const block of value.content as unknown[]) {
			if (!isObject(block)) continue;
			if (typeof block.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
		}
		summary.contentBytes = bytes;
		outputBytes += bytes;
		hasOutput = true;
	}
	if (hasOutput) summary.outputBytes = outputBytes;
	const paths = new Set<string>();
	const addPath = (path: unknown) => {
		if (typeof path === "string" && path.length > 0 && paths.size < 32) paths.add(redactText(path));
	};
	for (const source of [value, value.details]) {
		if (!isObject(source)) continue;
		addPath(source.fullOutputPath);
		addPath(source.artifactPath);
		if (Array.isArray(source.artifactPaths)) for (const path of source.artifactPaths as unknown[]) addPath(path);
		if (Array.isArray(source.artifacts)) {
			for (const artifact of source.artifacts as unknown[]) addPath(isObject(artifact) ? artifact.path : artifact);
		}
	}
	if (paths.size) summary.artifactPaths = [...paths];
	return summary;
}

export function recordExecution(event: ExecutionEvent, recordInputs: boolean): EvidenceRecord {
	const request = serializable(event.execution);
	const record: EvidenceRecord = {
		schemaVersion: 1,
		executionId: event.executionId,
		phase: event.phase,
		kind: event.execution.kind,
		timestamp: event.timestamp,
		inputHash: digest(JSON.stringify(request)),
		error: { present: event.error !== undefined || event.outcome === "failed" },
	};
	if (event.execution.kind === "tool") record.toolName = event.execution.toolName;
	if (event.durationMs !== undefined) record.durationMs = event.durationMs;
	if (event.outcome !== undefined) record.outcome = event.outcome;
	if (event.error !== undefined) {
		record.error.hash = digest(event.error);
		record.error.bytes = Buffer.byteLength(event.error, "utf8");
	}
	if (event.result !== undefined) record.result = summarizeResult(event.result);
	if (recordInputs) record.request = redact(request);
	return record;
}

function isNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isJson(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item: unknown) => isJson(item));
	return isObject(value) && Object.values(value).every(isJson);
}

/** Validate persisted data and project known fields; never export arbitrary custom-entry data. */
export function readEvidence(value: unknown): EvidenceRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== 1) return undefined;
	if (typeof value.executionId !== "string" || !value.executionId) return undefined;
	if (value.phase !== "policy" && value.phase !== "start" && value.phase !== "end") return undefined;
	if (value.kind !== "tool" && value.kind !== "exec" && value.kind !== "user_bash") return undefined;
	if (!isNonnegative(value.timestamp) || !isHash(value.inputHash)) return undefined;
	if (!isObject(value.error) || typeof value.error.present !== "boolean") return undefined;
	const record: EvidenceRecord = {
		schemaVersion: 1,
		executionId: value.executionId,
		phase: value.phase,
		kind: value.kind,
		timestamp: value.timestamp,
		inputHash: value.inputHash,
		error: { present: value.error.present },
	};
	if (value.kind === "tool") {
		if (typeof value.toolName !== "string" || !value.toolName) return undefined;
		record.toolName = value.toolName;
	}
	if (value.durationMs !== undefined) {
		if (!isNonnegative(value.durationMs)) return undefined;
		record.durationMs = value.durationMs;
	}
	if (value.outcome !== undefined) {
		if (
			value.outcome !== "allowed" &&
			value.outcome !== "blocked" &&
			value.outcome !== "failed" &&
			value.outcome !== "cancelled" &&
			value.outcome !== "succeeded"
		)
			return undefined;
		record.outcome = value.outcome;
	}
	if (value.error.hash !== undefined) {
		if (!isHash(value.error.hash)) return undefined;
		record.error.hash = value.error.hash;
	}
	if (value.error.bytes !== undefined) {
		if (!isNonnegative(value.error.bytes)) return undefined;
		record.error.bytes = value.error.bytes;
	}
	if (value.result !== undefined) {
		if (!isObject(value.result)) return undefined;
		const result: ResultSummary = {};
		if (value.result.code !== undefined) {
			if (
				value.result.code !== null &&
				(typeof value.result.code !== "number" || !Number.isFinite(value.result.code))
			)
				return undefined;
			result.code = value.result.code;
		}
		for (const key of ["killed", "cancelled", "isError", "truncated"] as const) {
			if (value.result[key] === undefined) continue;
			if (typeof value.result[key] !== "boolean") return undefined;
			result[key] = value.result[key];
		}
		for (const key of ["stdoutBytes", "stderrBytes", "outputBytes", "contentBytes"] as const) {
			if (value.result[key] === undefined) continue;
			if (!isNonnegative(value.result[key])) return undefined;
			result[key] = value.result[key];
		}
		if (value.result.artifactPaths !== undefined) {
			if (!Array.isArray(value.result.artifactPaths) || value.result.artifactPaths.length > 32) return undefined;
			const paths: string[] = [];
			for (const path of value.result.artifactPaths as unknown[]) {
				if (typeof path !== "string" || !path) return undefined;
				paths.push(path);
			}
			result.artifactPaths = paths;
		}
		record.result = result;
	}
	if (value.request !== undefined) {
		const request = value.request;
		if (!isObject(request) || request.kind !== value.kind || typeof request.cwd !== "string" || !isJson(request)) {
			return undefined;
		}
		if (request.kind === "tool") {
			if (request.toolName !== record.toolName || typeof request.toolCallId !== "string" || !isObject(request.input))
				return undefined;
		} else {
			if (typeof request.command !== "string") return undefined;
			if (request.kind === "exec") {
				if (
					typeof request.extensionPath !== "string" ||
					!Array.isArray(request.args) ||
					!request.args.every((arg: unknown) => typeof arg === "string") ||
					(request.timeout !== undefined && !isNonnegative(request.timeout))
				)
					return undefined;
			}
		}
		record.request = redact(request);
	}
	return record;
}
