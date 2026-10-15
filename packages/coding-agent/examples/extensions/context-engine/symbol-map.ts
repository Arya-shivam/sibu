import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerPool } from "../code-intelligence/server-pool.ts";

export interface SymbolSummary {
	name: string;
	kind: number;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	container?: string;
}

export interface SymbolMapResult {
	files: { path: string; hash: string; symbols: SymbolSummary[] }[];
	omittedFiles: number;
	omittedSymbols: number;
}

interface Position {
	line: number;
	character: number;
}

interface RankedSymbol {
	fileIndex: number;
	symbol: SymbolSummary;
	score: number;
	order: number;
}

const MAX_FILES = 12;
const MAX_SYMBOLS = 80;
const MAX_OUTPUT_BYTES = 20 * 1024;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function position(value: unknown): value is Position {
	return (
		record(value) &&
		Number.isSafeInteger(value.line) &&
		typeof value.line === "number" &&
		value.line >= 0 &&
		Number.isSafeInteger(value.character) &&
		typeof value.character === "number" &&
		value.character >= 0
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function relevance(name: string, fileName: string, terms: string[]): number {
	const lowerName = name.toLowerCase();
	const lowerFileName = fileName.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (lowerName === term) score += 8;
		else if (lowerName.includes(term)) score += 4;
		if (lowerFileName.includes(term)) score += 1;
	}
	return score;
}

/** Normalize only structural declarations for the requested file, never implementation evidence. */
function normalizeSymbols(value: unknown, path: string): SymbolSummary[] {
	if (value === null) return [];
	if (!Array.isArray(value)) throw new Error("Language server returned an invalid document symbol list");
	const symbols: SymbolSummary[] = [];
	const pending: { value: unknown; container?: string }[] = [];
	for (let index = value.length - 1; index >= 0; index--) pending.push({ value: value[index] });
	while (pending.length > 0) {
		const entry = pending.pop();
		if (!entry || !record(entry.value)) throw new Error("Language server returned an invalid document symbol");
		const item = entry.value;
		if (typeof item.name !== "string" || typeof item.kind !== "number" || !Number.isSafeInteger(item.kind)) {
			throw new Error("Language server returned an invalid symbol name or kind");
		}
		let range: unknown = item.range;
		let container = entry.container;
		if ("location" in item) {
			if (!record(item.location) || typeof item.location.uri !== "string") {
				throw new Error("Language server returned an invalid symbol location");
			}
			const uri = new URL(item.location.uri);
			if (uri.protocol !== "file:") continue;
			const target = resolve(fileURLToPath(uri));
			const sameFile = process.platform === "win32" ? target.toLowerCase() === path.toLowerCase() : target === path;
			if (!sameFile) continue;
			range = item.location.range;
			if (typeof item.containerName === "string") container = item.containerName;
		}
		if (
			!record(range) ||
			!position(range.start) ||
			!position(range.end) ||
			range.end.line < range.start.line ||
			(range.end.line === range.start.line && range.end.character < range.start.character)
		) {
			throw new Error("Language server returned an invalid symbol range");
		}
		symbols.push({
			name: item.name,
			kind: item.kind,
			line: range.start.line + 1,
			column: range.start.character + 1,
			endLine: range.end.line + 1,
			endColumn: range.end.character + 1,
			...(container !== undefined ? { container } : {}),
		});
		if (item.children !== undefined) {
			if (!Array.isArray(item.children)) throw new Error("Language server returned invalid symbol children");
			for (let index = item.children.length - 1; index >= 0; index--) {
				pending.push({ value: item.children[index], container: item.name });
			}
		}
	}
	return symbols;
}

/** Explicit candidates only. Hashes identify the stable disk snapshots queried through the LSP client. */
export async function buildSymbolMap(
	pool: ServerPool,
	paths: string[],
	cwd: string,
	configPath: string,
	query: string | undefined,
	signal?: AbortSignal,
): Promise<SymbolMapResult> {
	signal?.throwIfAborted();
	const terms = [...new Set(query?.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [])];
	const uniquePaths = new Set<string>();
	for (const path of paths) {
		signal?.throwIfAborted();
		const candidate = /^file:/i.test(path) ? fileURLToPath(path) : resolve(cwd, path);
		let canonical = await realpath(candidate);
		if (process.platform === "win32") canonical = canonical.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
		uniquePaths.add(canonical);
	}
	const candidates = [...uniquePaths].map((path) => ({
		path,
		score: relevance("", basename(path), terms),
	}));
	candidates.sort((left, right) => right.score - left.score || compareText(left.path, right.path));
	const result: SymbolMapResult = {
		files: [],
		omittedFiles: Math.max(0, candidates.length - MAX_FILES),
		omittedSymbols: 0,
	};
	const ranked: RankedSymbol[] = [];
	for (const { path } of candidates.slice(0, MAX_FILES)) {
		signal?.throwIfAborted();
		const client = await pool.get(path, cwd, configPath, signal);
		const before = createHash("sha256")
			.update(await readFile(path, { signal }))
			.digest("hex");
		const response = await client.query("symbols", path, undefined, undefined, signal);
		const after = createHash("sha256")
			.update(await readFile(path, { signal }))
			.digest("hex");
		if (before !== after) throw new Error(`Source file changed while querying symbols: ${path}`);
		const symbols = normalizeSymbols(response, path);
		result.omittedSymbols += symbols.length;
		const fileIndex = result.files.length;
		result.files.push({ path, hash: before, symbols: [] });
		if (Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > MAX_OUTPUT_BYTES) {
			result.files.pop();
			result.omittedFiles++;
			continue;
		}
		for (let order = 0; order < symbols.length; order++) {
			const symbol = symbols[order];
			ranked.push({ fileIndex, symbol, score: relevance(symbol.name, basename(path), terms), order });
		}
	}
	ranked.sort(
		(left, right) =>
			right.score - left.score ||
			compareText(result.files[left.fileIndex].path, result.files[right.fileIndex].path) ||
			left.symbol.line - right.symbol.line ||
			left.symbol.column - right.symbol.column ||
			compareText(left.symbol.name, right.symbol.name) ||
			left.symbol.kind - right.symbol.kind ||
			left.order - right.order,
	);
	let included = 0;
	for (const { fileIndex, symbol } of ranked) {
		if (included === MAX_SYMBOLS) break;
		const symbols = result.files[fileIndex].symbols;
		symbols.push(symbol);
		result.omittedSymbols--;
		if (Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > MAX_OUTPUT_BYTES) {
			symbols.pop();
			result.omittedSymbols++;
		} else {
			included++;
		}
	}
	signal?.throwIfAborted();
	return result;
}
