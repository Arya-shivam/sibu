import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LanguageServer } from "../examples/extensions/code-intelligence/client.ts";

const compiler = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
let directory: string;
let client: LanguageServer;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
	await writeFile(
		join(directory, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
	);
	await writeFile(join(directory, "model.ts"), "export const count = 1;\n");
	await writeFile(join(directory, "use.ts"), 'import { count } from "./model";\nexport const total = count + 1;\n');
	client = new LanguageServer(
		{
			command: process.execPath,
			args: [compiler, "--lsp", "--stdio"],
			languageId: "typescript",
			extensions: [".ts"],
		},
		directory,
	);
});

afterEach(async () => {
	await client.stop();
	await rm(directory, { recursive: true, force: true });
});

describe("code intelligence with the installed TypeScript language server", () => {
	test("resolves definitions and references across files without changing source", async () => {
		await Promise.all([client.start(), client.start()]);
		const definition = await client.query(
			"definition",
			join(directory, "use.ts"),
			{ line: 1, character: 21 },
			undefined,
		);
		const locations = definition as {
			targetUri: string;
			targetSelectionRange: { start: { line: number; character: number } };
		}[];
		expect(fileURLToPath(locations[0].targetUri).toLowerCase()).toBe(join(directory, "model.ts").toLowerCase());
		expect(locations[0].targetSelectionRange.start).toEqual({ line: 0, character: 13 });
		const references = (await client.query(
			"references",
			join(directory, "model.ts"),
			{ line: 0, character: 14 },
			undefined,
		)) as { uri: string }[];
		expect(new Set(references.map((item) => fileURLToPath(item.uri).toLowerCase()))).toEqual(
			new Set([join(directory, "model.ts").toLowerCase(), join(directory, "use.ts").toLowerCase()]),
		);
		const preview = await client.query(
			"rename_preview",
			join(directory, "model.ts"),
			{ line: 0, character: 14 },
			"quantity",
		);
		expect(JSON.stringify(preview)).toContain('"newText":"quantity"');
		expect(await readFile(join(directory, "model.ts"), "utf8")).toBe("export const count = 1;\n");
		expect(await readFile(join(directory, "use.ts"), "utf8")).toContain("total = count + 1");
	}, 30_000);

	test("refreshes previously opened files when the next query targets another file", async () => {
		await client.query("hover", join(directory, "model.ts"), { line: 0, character: 14 }, undefined);
		await writeFile(join(directory, "model.ts"), 'export const count = "changed";\n');
		const hover = await client.query("hover", join(directory, "use.ts"), { line: 1, character: 21 }, undefined);
		expect(JSON.stringify(hover)).toContain("changed");
	}, 30_000);

	test("returns current diagnostics after an error is introduced and fixed", async () => {
		const path = join(directory, "model.ts");
		await writeFile(path, 'export const count: number = "wrong";\n');
		const errors = await client.query("diagnostics", path, undefined, undefined);
		expect(JSON.stringify(errors)).toContain("2322");
		await writeFile(path, "export const count: number = 1;\n");
		const clean = await client.query("diagnostics", path, undefined, undefined);
		expect(JSON.stringify(clean)).not.toContain("2322");
	}, 30_000);

	test("aborted requests do not poison subsequent navigation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			client.query("symbols", join(directory, "model.ts"), undefined, undefined, controller.signal),
		).rejects.toThrow();
		const symbols = await client.query("symbols", join(directory, "model.ts"), undefined, undefined);
		expect(JSON.stringify(symbols)).toContain('"name":"count"');
	}, 30_000);

	test("reports missing executables instead of hanging", async () => {
		const missing = new LanguageServer(
			{
				command: resolve(directory, "missing-language-server"),
				args: [],
				languageId: "typescript",
				extensions: [".ts"],
			},
			directory,
		);
		try {
			await expect(missing.start()).rejects.toThrow();
		} finally {
			await missing.stop();
		}
	}, 10_000);
});
