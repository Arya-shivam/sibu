import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, truncateHead } from "@earendil-works/pi-coding-agent";
import { ServerPool } from "../code-intelligence/server-pool.ts";
import { SourceIndex } from "./source-index.ts";
import { buildSymbolMap } from "./symbol-map.ts";

async function summaryResult(value: unknown) {
	const text = JSON.stringify(value, null, 2);
	const bounded = truncateHead(text, { maxBytes: 24 * 1024, maxLines: 500 });
	let fullOutputPath: string | undefined;
	if (bounded.truncated) {
		fullOutputPath = join(await mkdtemp(join(tmpdir(), "pi-context-map-")), "result.json");
		await writeFile(fullOutputPath, text);
	}
	return {
		content: [
			{ type: "text" as const, text: bounded.content + (fullOutputPath ? `\nFull result: ${fullOutputPath}` : "") },
		],
		details: { structuralOnly: true, fullOutputPath },
	};
}

export default function contextEngine(pi: ExtensionAPI) {
	const sources = new SourceIndex();
	const servers = new ServerPool();
	pi.registerFlag("context-lsp-config", {
		type: "string",
		description: "Trusted LSP configuration for Context Engine symbol maps (same format as --lsp-config)",
	});
	pi.registerCleanup(() => servers.stop());
	pi.on("session_start", () => sources.clear());
	pi.on("context_with_system", async (event, ctx) => {
		sources.observe(event.messages);
		const stale = (await sources.status(ctx.signal, true)).filter((entry) => entry.state !== "current");
		if (stale.length === 0) return;
		const shown = stale.slice(0, 16);
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content:
						"[Context Engine freshness notice]\nEarlier source excerpts are stale or unavailable:\n" +
						shown.map((entry) => `${entry.path}: ${entry.state} (inspected SHA-256 ${entry.hash})`).join("\n") +
						(stale.length > shown.length ? `\n${stale.length - shown.length} additional stale files.` : "") +
						"\nRead current source with source_context before relying on that implementation. Symbol maps describe structure, not inspected source.",
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.registerTool(
		defineTool({
			name: "source_context",
			label: "Source context",
			description:
				"Version-aware local text source retrieval and bounded LSP symbol maps. read hashes a fresh disk snapshot and returns numbered complete lines; unchanged ranges may reference exact source still in active context. force=true always returns text. status checks observed versions. symbols/map return structure, not implementation evidence. Does not replace ordinary read or search tools.",
			promptSnippet: "Retrieve versioned source ranges and compact symbol maps",
			promptGuidelines: [
				"Use source_context for text source retrieval; force=true when exact text is needed again. Inspect source before editing; a symbol map alone is not implementation evidence.",
			],
			executionMode: "sequential",
			parameters: Type.Object({
				action: StringEnum(["read", "status", "symbols", "map"] as const),
				path: Type.Optional(Type.String({ description: "Source file for read or symbols" })),
				paths: Type.Optional(
					Type.Array(Type.String(), {
						maxItems: 128,
						description: "Candidate source files for a bounded symbol map; no implicit repository scan",
					}),
				),
				offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line, 1-based" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum complete lines" })),
				force: Type.Optional(
					Type.Boolean({ description: "Return source text even when unchanged and already in active context" }),
				),
				query: Type.Optional(
					Type.String({ description: "Rank symbol names and file names by these search terms" }),
				),
			}),
			async execute(_id, params, signal, _update, ctx) {
				signal?.throwIfAborted();
				if (params.action === "read") {
					if (!params.path) throw new Error("read requires path");
					const path = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
					const result = await sources.read(
						path,
						{ offset: params.offset, limit: params.limit, force: params.force },
						signal,
					);
					return {
						content: [{ type: "text", text: result.text }],
						details: { sourceProof: result.proof, reused: result.reused },
					};
				}
				if (params.action === "status") {
					const status = await sources.status(signal);
					return summaryResult(status);
				}
				const paths = params.action === "symbols" ? (params.path ? [params.path] : []) : (params.paths ?? []);
				if (paths.length === 0)
					throw new Error(`${params.action} requires ${params.action === "symbols" ? "path" : "paths"}`);
				const config = pi.getFlag("context-lsp-config");
				if (typeof config !== "string" || !config)
					throw new Error(
						"Pass --context-lsp-config /path/to/trusted-lsp.json for symbol maps; source read/status do not require a language server",
					);
				const map = await buildSymbolMap(servers, paths, ctx.cwd, resolve(ctx.cwd, config), params.query, signal);
				return summaryResult(map);
			},
		}),
	);
}
