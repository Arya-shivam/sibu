import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { ServerPool } from "./server-pool.ts";

export default function codeIntelligence(pi: ExtensionAPI) {
	const pool = new ServerPool();
	pi.registerFlag("lsp-config", {
		type: "string",
		description: "Trusted JSON LSP server configuration (commands run with Pi's permissions)",
	});
	const stop = () => pool.stop();
	pi.on("session_start", stop);
	pi.registerCleanup(stop);

	pi.registerTool(
		defineTool({
			name: "code_intelligence",
			label: "Code intelligence",
			description:
				"Navigate code with a configured language server: definitions, references, hover, document symbols, diagnostics, and rename preview. Never applies edits. Input positions are 1-based UTF-16; returned LSP ranges are 0-based UTF-16. Requires --lsp-config. Servers are trusted local processes, not a sandbox.",
			executionMode: "sequential",
			parameters: Type.Object({
				action: StringEnum([
					"definition",
					"references",
					"hover",
					"symbols",
					"diagnostics",
					"rename_preview",
				] as const),
				path: Type.String({ description: "Source file, relative to the working directory or absolute" }),
				line: Type.Optional(Type.Integer({ minimum: 1 })),
				column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based UTF-16 column" })),
				newName: Type.Optional(Type.String({ minLength: 1, description: "Required for rename_preview" })),
			}),
			async execute(_id, params, signal, _update, ctx) {
				signal?.throwIfAborted();
				const needsPosition = !["symbols", "diagnostics"].includes(params.action);
				if (needsPosition && (params.line === undefined || params.column === undefined)) {
					throw new Error(`${params.action} requires line and column`);
				}
				if (params.action === "rename_preview" && !params.newName?.trim())
					throw new Error("rename_preview requires newName");
				const flag = pi.getFlag("lsp-config");
				if (typeof flag !== "string" || !flag)
					throw new Error(
						"Pass --lsp-config /path/to/trusted-lsp.json; no server is installed or started automatically",
					);
				const path = resolve(ctx.cwd, params.path);
				const source = await readFile(path, "utf8");
				let position: { line: number; character: number } | undefined;
				if (needsPosition) {
					const line = (params.line ?? 1) - 1;
					const character = (params.column ?? 1) - 1;
					const lines = source.split(/\r?\n/);
					if (line >= lines.length || character > lines[line].length)
						throw new Error("Position is outside the source file");
					position = { line, character };
				}
				const server = await pool.get(path, ctx.cwd, flag, signal);
				const result = await server.query(params.action, path, position, params.newName, signal);
				const text = JSON.stringify(
					{ action: params.action, path, rangeEncoding: "0-based UTF-16", result },
					null,
					2,
				);
				const truncated = truncateHead(text);
				let fullOutputPath: string | undefined;
				if (truncated.truncated) {
					const directory = await mkdtemp(join(tmpdir(), "pi-code-intelligence-"));
					fullOutputPath = join(directory, "result.json");
					await writeFile(fullOutputPath, text);
				}
				return {
					content: [
						{
							type: "text",
							text: truncated.content + (fullOutputPath ? `\nFull result: ${fullOutputPath}` : ""),
						},
					],
					details: { action: params.action, path, fullOutputPath },
				};
			},
		}),
	);
}
