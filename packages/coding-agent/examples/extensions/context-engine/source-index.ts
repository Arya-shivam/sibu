import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SourceProof {
	version: 1;
	kind: "source";
	path: string;
	hash: string;
	startLine: number;
	endLine: number;
	outputHash: string;
}

export interface SourceRead {
	text: string;
	proof?: SourceProof;
	reused: boolean;
}

export interface SourceStatus {
	path: string;
	hash: string;
	currentHash?: string;
	state: "current" | "changed" | "missing" | "unavailable";
	ranges: { startLine: number; endLine: number }[];
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 24 * 1024;
const MAX_LINES = 200;
const MAX_FILES = 128;
const MAX_PROOFS = 512;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface TrackedRange {
	startLine: number;
	endLine: number;
	visible: boolean;
	sequence: number;
}

interface TrackedFile {
	hash: string;
	ranges: TrackedRange[];
}

interface Selection {
	text: string;
	startLine: number;
	endLine: number;
	hasMore: boolean;
}

function hashBytes(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalPath(path: string): string {
	const normalized = normalize(path);
	// Realpath supplies filesystem spelling. Do not fold directory names: Windows
	// can also host case-sensitive directories.
	return process.platform === "win32" ? normalized.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : normalized;
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive finite integer.`);
}

function isProof(value: unknown): value is SourceProof {
	if (typeof value !== "object" || value === null) return false;
	return (
		"version" in value &&
		value.version === 1 &&
		"kind" in value &&
		value.kind === "source" &&
		"path" in value &&
		typeof value.path === "string" &&
		value.path.length > 0 &&
		value.path.length <= 32768 &&
		!value.path.includes("\0") &&
		isAbsolute(value.path) &&
		"hash" in value &&
		typeof value.hash === "string" &&
		HASH_PATTERN.test(value.hash) &&
		"outputHash" in value &&
		typeof value.outputHash === "string" &&
		HASH_PATTERN.test(value.outputHash) &&
		"startLine" in value &&
		typeof value.startLine === "number" &&
		Number.isSafeInteger(value.startLine) &&
		value.startLine >= 1 &&
		"endLine" in value &&
		typeof value.endLine === "number" &&
		Number.isSafeInteger(value.endLine) &&
		value.endLine >= value.startLine &&
		value.endLine - value.startLine < MAX_LINES
	);
}

async function readBytes(path: string, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted();
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Source path must name a regular file.");
		if (stat.size > MAX_FILE_BYTES) throw new Error("Source file exceeds the 8 MiB limit.");
		const chunks: Buffer[] = [];
		let length = 0;
		while (length <= MAX_FILE_BYTES) {
			signal?.throwIfAborted();
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - length));
			const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
			if (length > MAX_FILE_BYTES) throw new Error("Source file exceeds the 8 MiB limit.");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		signal?.throwIfAborted();
		return Buffer.concat(chunks, length);
	} finally {
		await file.close();
	}
}

function selectLines(source: string, offset: number, limit: number): Selection {
	// The empty file has one empty display line; a terminal newline does not
	// create an additional line. Both cases therefore have stable 1-based ranges.
	let start = 0;
	let line = 1;
	while (line < offset) {
		const newline = source.indexOf("\n", start);
		if (newline === -1 || newline === source.length - 1) {
			throw new Error(`offset ${offset} is beyond the end of the file (last line ${line}).`);
		}
		start = newline + 1;
		line++;
	}

	const rendered: string[] = [];
	let selectedBytes = 0;
	let endLine = offset;
	let position = start;
	let hasMore = false;
	for (let count = 0; count < Math.min(limit, MAX_LINES); count++) {
		const newline = source.indexOf("\n", position);
		const end = newline === -1 ? source.length : newline + 1;
		const fullLine = source.slice(position, end);
		const lineBytes = Buffer.byteLength(fullLine, "utf8");
		if (selectedBytes + lineBytes > MAX_SOURCE_BYTES) {
			if (count === 0) throw new Error(`Line ${offset} exceeds the 24 KiB source range limit.`);
			hasMore = true;
			break;
		}
		selectedBytes += lineBytes;
		endLine = offset + count;
		rendered.push(`${endLine}: ${fullLine}${fullLine.endsWith("\n") ? "" : "\n"}`);
		position = end;
		hasMore = position < source.length;
		if (!hasMore) break;
	}
	return { text: rendered.join(""), startLine: offset, endLine, hasMore };
}

export class SourceIndex {
	private readonly files = new Map<string, TrackedFile>();
	private sequence = 0;

	async read(
		path: string,
		options: { offset?: number; limit?: number; force?: boolean },
		signal?: AbortSignal,
	): Promise<SourceRead> {
		const offset = options.offset ?? 1;
		const limit = options.limit ?? MAX_LINES;
		positiveInteger(offset, "offset");
		positiveInteger(limit, "limit");
		signal?.throwIfAborted();
		const resolved = canonicalPath(await realpath(path));
		const bytes = await readBytes(resolved, signal);
		const hash = hashBytes(bytes);
		const file = this.rememberFile(resolved, hash);
		let source: string;
		try {
			source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new Error("Source file is not valid UTF-8.");
		}
		if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(source)) {
			throw new Error("Source file appears to be binary.");
		}
		const selection = selectLines(source, offset, limit);
		const header = `Source: ${JSON.stringify(resolved)}\nSHA-256: ${hash}\nLines: ${selection.startLine}-${selection.endLine}`;
		const continuation = selection.hasMore ? `\nContinue with offset=${selection.endLine + 1}.` : "";
		const visible = file.ranges.some(
			(range) => range.visible && range.startLine <= selection.startLine && range.endLine >= selection.endLine,
		);
		if (!options.force && visible) {
			return {
				text: `${header}\nAlready visible in the active context; source not repeated.${continuation}`,
				reused: true,
			};
		}
		const text = `${header}\n\n${selection.text}${continuation}`;
		const proof: SourceProof = {
			version: 1,
			kind: "source",
			path: resolved,
			hash,
			startLine: selection.startLine,
			endLine: selection.endLine,
			outputHash: hashBytes(text),
		};
		this.rememberRange(file, proof.startLine, proof.endLine, false);
		return { text, proof, reused: false };
	}

	observe(messages: AgentMessage[]): void {
		for (const file of this.files.values()) {
			for (const range of file.ranges) range.visible = false;
		}
		for (const message of messages) {
			if (
				message.role !== "toolResult" ||
				message.toolName !== "source_context" ||
				message.isError ||
				message.content.length !== 1 ||
				message.content[0].type !== "text" ||
				typeof message.details !== "object" ||
				message.details === null ||
				!("sourceProof" in message.details) ||
				("reused" in message.details && message.details.reused === true)
			) {
				continue;
			}
			const proof = message.details.sourceProof;
			if (!isProof(proof) || hashBytes(message.content[0].text) !== proof.outputHash) continue;
			const file = this.rememberFile(canonicalPath(proof.path), proof.hash);
			this.rememberRange(file, proof.startLine, proof.endLine, true);
		}
	}

	async status(signal?: AbortSignal, visibleOnly = false): Promise<SourceStatus[]> {
		signal?.throwIfAborted();
		const results: SourceStatus[] = [];
		for (const [path, file] of this.files) {
			const ranges = file.ranges.filter((range) => !visibleOnly || range.visible);
			if (visibleOnly && ranges.length === 0) continue;
			signal?.throwIfAborted();
			const status: SourceStatus = {
				path,
				hash: file.hash,
				ranges: ranges.map(({ startLine, endLine }) => ({ startLine, endLine })),
				state: "unavailable",
			};
			try {
				status.currentHash = hashBytes(await readBytes(path, signal));
				status.state = status.currentHash === file.hash ? "current" : "changed";
			} catch (error) {
				signal?.throwIfAborted();
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					(error.code === "ENOENT" || error.code === "ENOTDIR")
				) {
					status.state = "missing";
				}
			}
			results.push(status);
		}
		return results;
	}

	clear(): void {
		this.files.clear();
		this.sequence = 0;
	}

	private rememberFile(path: string, hash: string): TrackedFile {
		let file = this.files.get(path);
		if (!file) {
			file = { hash, ranges: [] };
		} else if (file.hash !== hash) {
			file.hash = hash;
			file.ranges = [];
		}
		this.files.delete(path);
		this.files.set(path, file);
		if (this.files.size > MAX_FILES) {
			const oldest = this.files.keys().next().value;
			if (oldest !== undefined) this.files.delete(oldest);
		}
		return file;
	}

	private rememberRange(file: TrackedFile, startLine: number, endLine: number, visible: boolean): void {
		const existing = file.ranges.find((range) => range.startLine === startLine && range.endLine === endLine);
		if (existing) {
			existing.visible ||= visible;
			existing.sequence = ++this.sequence;
		} else {
			file.ranges.push({ startLine, endLine, visible, sequence: ++this.sequence });
		}
		let count = 0;
		let oldestFile: TrackedFile | undefined;
		let oldestIndex = -1;
		let oldestSequence = Number.POSITIVE_INFINITY;
		for (const tracked of this.files.values()) {
			count += tracked.ranges.length;
			for (let i = 0; i < tracked.ranges.length; i++) {
				if (tracked.ranges[i].sequence < oldestSequence) {
					oldestSequence = tracked.ranges[i].sequence;
					oldestFile = tracked;
					oldestIndex = i;
				}
			}
		}
		if (count > MAX_PROOFS) oldestFile?.ranges.splice(oldestIndex, 1);
	}
}
