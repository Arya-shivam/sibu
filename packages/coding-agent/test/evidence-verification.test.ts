import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import recorder from "../examples/extensions/execution-recorder/index.ts";
import verification from "../examples/extensions/verification/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionResult, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let directory: string;
let active: CreateAgentSessionResult | undefined;
let exec: ExtensionAPI["exec"];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-evidence-test-"));
});
afterEach(async () => {
	if (active) {
		await emitSessionShutdownEvent(active.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		active.session.dispose();
		active = undefined;
	}
	await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function setup(extra?: ExtensionFactory) {
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: join(directory, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			recorder,
			verification,
			(pi) => {
				exec = pi.exec;
				extra?.(pi);
			},
		],
	});
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	active = await createAgentSession({
		cwd: directory,
		agentDir: join(directory, "agent"),
		settingsManager,
		resourceLoader: loader,
		modelRuntime,
		sessionManager: SessionManager.inMemory(directory),
	});
	const errors: string[] = [];
	await active.session.bindExtensions({ onError: (error) => errors.push(error.error) });
	expect(errors).toEqual([]);
	return active;
}

function entries(customType: string): Record<string, unknown>[] {
	if (!active) throw new Error("Session missing");
	return active.session.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== customType) return [];
		const data: unknown = entry.data;
		return data && typeof data === "object" && !Array.isArray(data) ? [data as Record<string, unknown>] : [];
	});
}

async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
	if (!active) throw new Error("Session missing");
	const tool = active.session.agent.state.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Tool ${name} missing`);
	return tool.execute(randomUUID(), args, signal);
}

async function configure(command: string) {
	if (!active) throw new Error("Session missing");
	await writeFile(join(directory, "source.ts"), "export const value = 1;\n");
	const path = join(directory, "checks.json");
	await writeFile(
		path,
		JSON.stringify({
			checks: [{ id: "check", command: process.execPath, args: ["-e", command], files: ["source.ts"] }],
		}),
	);
	active.extensionsResult.runtime.flagValues.set("verification-config", path);
}

describe("durable execution evidence", () => {
	test("records actual successful execution without duplicating secret argv or output", async () => {
		await setup();
		const secret = "private-token-do-not-store";
		const result = await exec(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(secret)})`]);
		expect(result.stdout).toBe(secret);
		const records = entries("execution-evidence");
		expect(records.some((record) => record.phase === "start")).toBe(true);
		expect(records.some((record) => record.phase === "end" && record.outcome === "succeeded")).toBe(true);
		expect(JSON.stringify(records)).not.toContain(secret);
		const end = records.find((record) => record.phase === "end");
		expect(records.filter((record) => record.executionId === end?.executionId).map((record) => record.phase)).toEqual(
			["policy", "start", "end"],
		);
	});

	test("explicit input recording redacts sensitive argv while retaining useful command structure", async () => {
		const { extensionsResult } = await setup();
		extensionsResult.runtime.flagValues.set("record-inputs", true);
		const secret = "never-export-this-token";
		const result = await exec(process.execPath, [
			"-e",
			"process.stdout.write(process.argv[2])",
			"--",
			"--token",
			secret,
		]);
		expect(result.stdout).toBe(secret);
		const serialized = JSON.stringify(entries("execution-evidence"));
		expect(serialized).toContain("--token");
		expect(serialized).toContain("[REDACTED]");
		expect(serialized).not.toContain(secret);
	});

	test("denied execution has a policy record but no operation start or file effect", async () => {
		await setup((pi) => {
			pi.on("execution_guard", () => ({ block: true, reason: "policy denied" }));
		});
		const marker = join(directory, "never.txt");
		await expect(
			exec(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "bad")', marker]),
		).rejects.toThrow("policy denied");
		expect(existsSync(marker)).toBe(false);
		const records = entries("execution-evidence");
		expect(records).toEqual([expect.objectContaining({ phase: "policy", outcome: "blocked" })]);
	});

	test("an observer failure does not turn a completed action into a failed action", async () => {
		await setup((pi) => {
			pi.on("execution", () => {
				throw new Error("observer failed");
			});
		});
		const result = await exec(process.execPath, ["-e", 'process.stdout.write("completed")']);
		expect(result).toMatchObject({ stdout: "completed", code: 0, killed: false });
	});

	test("records nonzero exit codes as failed rather than succeeded", async () => {
		await setup();
		await exec(process.execPath, ["-e", "process.exitCode = 7"]);
		expect(entries("execution-evidence")).toContainEqual(
			expect.objectContaining({ phase: "end", outcome: "failed" }),
		);
	});

	test("cancelled native execution is not recorded as a successful exit", async () => {
		await setup();
		const controller = new AbortController();
		const ready = join(directory, "ready");
		const watcher = watch(directory, (_event, filename) => {
			if (filename?.toString() === "ready") controller.abort();
		});
		try {
			const command =
				'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => require("node:fs").writeFileSync(process.argv[1], "ready"));';
			const result = await exec(process.execPath, ["-e", command, ready], { signal: controller.signal });
			expect(result.killed).toBe(true);
			expect(entries("execution-evidence")).toContainEqual(
				expect.objectContaining({ phase: "end", outcome: "cancelled" }),
			);
		} finally {
			watcher.close();
		}
	});

	test("exports branch evidence without retaining abandoned branch records", async () => {
		const { session } = await setup();
		await exec(process.execPath, ["-e", "process.exitCode = 0"]);
		const savedLeaf = session.sessionManager.getLeafId();
		if (!savedLeaf) throw new Error("Missing recorded branch leaf");
		await exec(process.execPath, ["-e", "process.exitCode = 9"]);
		session.sessionManager.branch(savedLeaf);
		const path = join(directory, "evidence.jsonl");
		await call("execution_log", { action: "export", path });
		const exported = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(exported.some((record) => record.outcome === "succeeded")).toBe(true);
		expect(exported.some((record) => record.outcome === "failed")).toBe(false);
	});
});

describe("revision-bound verification", () => {
	test("a pass becomes stale after an external source edit and survives runtime reload", async () => {
		const { session } = await setup();
		await configure('process.stdout.write("checked")');
		const passed = await call("verify", { action: "run", check: "check" });
		expect(JSON.stringify(passed)).toContain("passed");
		await session.reload();
		active!.extensionsResult = session.resourceLoader.getExtensions();
		active!.extensionsResult.runtime.flagValues.set("verification-config", join(directory, "checks.json"));
		const current = await call("verify", { action: "status", check: "check" });
		expect(JSON.stringify(current)).toContain("passed");
		await writeFile(join(directory, "source.ts"), "export const value = 2;\n");
		const stale = await call("verify", { action: "status", check: "check" });
		expect(JSON.stringify(stale)).toContain("stale");
	});

	test("source changes during a successful command cannot produce a pass", async () => {
		await setup();
		await configure('require("node:fs").writeFileSync("source.ts", "export const value = 2;\\n")');
		await expect(call("verify", { action: "run", check: "check" })).rejects.toThrow("changed_during_check");
	});

	test("a newer failed attempt shadows an older pass on unchanged inputs", async () => {
		await setup();
		await configure('if (require("node:fs").existsSync("fail")) process.exitCode = 3');
		await call("verify", { action: "run", check: "check" });
		await writeFile(join(directory, "fail"), "fail");
		await expect(call("verify", { action: "run", check: "check" })).rejects.toThrow();
		const status = await call("verify", { action: "status", check: "check" });
		expect(JSON.stringify(status)).toContain("failed");
		expect(entries("verification-evidence")).toHaveLength(2);
	});

	test("changed check configuration invalidates an earlier pass", async () => {
		await setup();
		await configure("process.exitCode = 0");
		await call("verify", { action: "run", check: "check" });
		await configure("process.exitCode = 7");
		const status = await call("verify", { action: "status", check: "check" });
		expect(JSON.stringify(status)).toContain("stale");
	});

	test("a denied new verification attempt cannot leave an older pass current", async () => {
		let deny = false;
		await setup((pi) => {
			pi.on("execution_guard", ({ execution }) => {
				if (deny && execution.kind === "exec") return { block: true, reason: "policy denied" };
			});
		});
		await configure("process.exitCode = 0");
		await call("verify", { action: "run", check: "check" });
		deny = true;
		await expect(call("verify", { action: "run", check: "check" })).rejects.toThrow("denied");
		const status = await call("verify", { action: "status", check: "check" });
		expect(JSON.stringify(status)).toContain("denied");
		expect(entries("verification-evidence")).toHaveLength(2);
	});
});
