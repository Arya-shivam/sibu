import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ServerPool } from "../examples/extensions/code-intelligence/server-pool.ts";
import { SourceIndex, type SourceRead } from "../examples/extensions/context-engine/source-index.ts";
import { buildSymbolMap } from "../examples/extensions/context-engine/symbol-map.ts";

let directory: string;
let sources: SourceIndex;
let pool: ServerPool;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
	sources = new SourceIndex();
	pool = new ServerPool();
});
afterEach(async () => {
	await pool.stop();
	await rm(directory, { recursive: true, force: true });
});

function sourceMessage(result: SourceRead): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "source-1",
		toolName: "source_context",
		content: [{ type: "text", text: result.text }],
		details: result.proof ? { sourceProof: { ...result.proof } } : {},
		isError: false,
		timestamp: Date.now(),
	};
}

describe("version-aware source context", () => {
	test("only reuses unchanged ranges whose exact text remains in active context", async () => {
		const path = join(directory, "source.ts");
		await writeFile(path, "const first = 1;\nconst second = 2;\nconst third = 3;\n");
		const initial = await sources.read(path, { offset: 1, limit: 2 });
		sources.observe([sourceMessage(initial)]);
		expect((await sources.read(path, { offset: 2, limit: 1 })).reused).toBe(true);
		expect((await sources.read(path, { offset: 3, limit: 1 })).reused).toBe(false);
		sources.observe([]);
		const afterCompaction = await sources.read(path, { offset: 2, limit: 1 });
		expect(afterCompaction.reused).toBe(false);
		expect(afterCompaction.text).toContain("const second = 2;");
	});

	test("detects external equal-size edits even if timestamps are restored", async () => {
		const path = join(directory, "source.ts");
		await writeFile(path, "export const value = 1;\n");
		const initial = await sources.read(path, {});
		sources.observe([sourceMessage(initial)]);
		const before = await stat(path);
		await writeFile(path, "export const value = 2;\n");
		await utimes(path, before.atime, before.mtime);
		expect((await sources.status())[0].state).toBe("changed");
		const current = await sources.read(path, {});
		expect(current.reused).toBe(false);
		expect(current.text).toContain("value = 2");
		expect(current.proof?.hash).not.toBe(initial.proof?.hash);
	});

	test("does not trust a proof when a later transform removed or replaced its source text", async () => {
		const path = join(directory, "source.ts");
		await writeFile(path, "export const exact = 1;\n");
		const initial = await sources.read(path, {});
		const changed = sourceMessage(initial);
		if (changed.role !== "toolResult") throw new Error("Expected source tool result");
		changed.content = [{ type: "text", text: "Summary: a constant exists" }];
		sources.observe([changed]);
		expect((await sources.read(path, {})).reused).toBe(false);
	});

	test("rehydrates evidence from active branch messages, but symbols are not source evidence", async () => {
		const path = join(directory, "source.ts");
		await writeFile(path, "export const exact = 1;\n");
		const initial = await sources.read(path, {});
		const resumed = new SourceIndex();
		resumed.observe([sourceMessage(initial)]);
		expect((await resumed.read(path, {})).reused).toBe(true);
		resumed.observe([
			{
				role: "toolResult",
				toolCallId: "map",
				toolName: "source_context",
				content: [{ type: "text", text: "exact" }],
				details: { structuralOnly: true },
				isError: false,
				timestamp: Date.now(),
			},
		]);
		expect((await resumed.read(path, {})).reused).toBe(false);
	});

	test("force returns source and long output proves only complete delivered lines", async () => {
		const path = join(directory, "source.ts");
		await writeFile(
			path,
			Array.from({ length: 250 }, (_, index) => `export const item${index} = ${index};`).join("\n"),
		);
		const initial = await sources.read(path, {});
		expect(initial.proof?.endLine).toBe(200);
		sources.observe([sourceMessage(initial)]);
		expect((await sources.read(path, { offset: 201, limit: 1 })).reused).toBe(false);
		expect((await sources.read(path, { offset: 1, limit: 1, force: true })).text).toContain("item0");
	});

	test("deleted source becomes missing rather than current", async () => {
		const path = join(directory, "source.ts");
		await writeFile(path, "export const value = 1;\n");
		const initial = await sources.read(path, {});
		sources.observe([sourceMessage(initial)]);
		await rm(path);
		expect((await sources.status())[0].state).toBe("missing");
		await expect(sources.read(path, {})).rejects.toThrow();
	});

	test("binary data and partial overlong lines never become inspected source", async () => {
		const binary = join(directory, "binary.ts");
		await writeFile(binary, Buffer.from([0x00, 0xff, 0x01]));
		await expect(sources.read(binary, {})).rejects.toThrow();
		const long = join(directory, "long.ts");
		await writeFile(long, "x".repeat(25 * 1024));
		await expect(sources.read(long, {})).rejects.toThrow();
	});

	test("the empty file has a readable empty range, not an invented second line", async () => {
		const path = join(directory, "empty.ts");
		await writeFile(path, "");
		const initial = await sources.read(path, {});
		expect(initial.proof).toMatchObject({ startLine: 1, endLine: 1 });
		sources.observe([sourceMessage(initial)]);
		expect((await sources.read(path, {})).reused).toBe(true);
		await expect(sources.read(path, { offset: 2 })).rejects.toThrow();
	});
});

describe("bounded LSP symbol context", () => {
	test("ranks real symbols, preserves source hash, and refreshes after disk edits", async () => {
		const path = join(directory, "model.ts");
		const config = join(directory, "lsp.json");
		const compiler = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
		await writeFile(join(directory, "tsconfig.json"), '{"include":["*.ts"]}');
		await writeFile(
			config,
			JSON.stringify({
				servers: [
					{
						command: process.execPath,
						args: [compiler, "--lsp", "--stdio"],
						languageId: "typescript",
						extensions: [".ts"],
					},
				],
			}),
		);
		await writeFile(path, "export function unrelated() {}\nexport function calculateArea() {}\n");
		const initial = await buildSymbolMap(pool, [path], directory, config, "calculateArea");
		expect(initial.files[0].symbols[0].name).toBe("calculateArea");
		expect(initial.files[0].symbols[0].line).toBe(2);
		expect(initial.files[0].hash).toBe(
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		);
		await writeFile(path, "export function calculateVolume() {}\n");
		const updated = await buildSymbolMap(pool, [path], directory, config, "calculateVolume");
		expect(updated.files[0].symbols.map((symbol) => symbol.name)).toContain("calculateVolume");
		expect(updated.files[0].symbols.map((symbol) => symbol.name)).not.toContain("calculateArea");
		await writeFile(
			path,
			Array.from({ length: 120 }, (_, index) => `export const item${index} = ${index};`).join("\n"),
		);
		const bounded = await buildSymbolMap(pool, [path], directory, config, "item119");
		expect(bounded.files[0].symbols[0].name).toBe("item119");
		expect(bounded.files[0].symbols).toHaveLength(80);
		expect(bounded.omittedSymbols).toBe(40);
	}, 30_000);
});
