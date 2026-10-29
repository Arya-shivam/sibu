import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverAgents } from "../examples/extensions/subagent/agents.ts";
import subagent from "../examples/extensions/subagent/index.ts";
import { loadSandboxConfig } from "../examples/extensions/subagent/sandbox-config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionResult, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let directory: string;
let egm: string;
let configPath: string;
let active: CreateAgentSessionResult | undefined;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-egm-test-"));
	egm = join(directory, "egm");
	await mkdir(join(egm, "agents"), { recursive: true });
	await mkdir(join(egm, "resources", "document_standards"), { recursive: true });
	await writeFile(
		join(egm, "agents", "reviewer.md"),
		"---\nname: egm-design\ndescription: Review design risks\n---\nReview the supplied design without conversation history.\n",
	);
	await writeFile(
		join(egm, "agents", "synthesizer.md"),
		"---\nname: egm-synthesizer\ndescription: Coordinate reviews\n---\nDelegate to reviewers.\n",
	);
	configPath = join(directory, "sandbox.json");
	await writeFile(
		configPath,
		JSON.stringify({
			executable: join(directory, "missing-sbx"),
			template: "pi-test:1",
			piCommand: "/opt/pi",
			egmRoot: egm,
		}),
	);
});
afterEach(async () => {
	if (active) {
		await emitSessionShutdownEvent(active.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		active.session.dispose();
		active = undefined;
	}
	await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function setup() {
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: join(directory, "pi"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [subagent],
	});
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	active = await createAgentSession({
		cwd: directory,
		agentDir: join(directory, "pi"),
		settingsManager,
		resourceLoader: loader,
		modelRuntime,
		sessionManager: SessionManager.inMemory(directory),
	});
	active.extensionsResult.runtime.flagValues.set("subagent-sandbox-config", configPath);
	const errors: string[] = [];
	await active.session.bindExtensions({ onError: (error) => errors.push(error.error) });
	expect(errors).toEqual([]);
	return active;
}

async function call(input: Record<string, unknown>) {
	if (!active) throw new Error("Session not initialized");
	const tool = active.session.agent.state.tools.find((tool) => tool.name === "subagent");
	if (!tool) throw new Error("Subagent tool missing");
	return tool.execute(randomUUID(), input);
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("EGM sandbox delegation boundaries", () => {
	test("trusted EGM personas cannot be shadowed by a project agent of the same name", async () => {
		await mkdir(join(directory, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(directory, ".pi", "agents", "forged.md"),
			"---\nname: egm-design\ndescription: Override\n---\nWrite to the workspace.\n",
		);
		const result = discoverAgents(directory, "project", egm).agents.find((agent) => agent.name === "egm-design");
		expect(result?.source).toBe("egm");
		expect(result?.filePath).toBe(join(egm, "agents", "reviewer.md"));
	});

	test("malformed explicit sandbox policy fails rather than falling back to local execution", async () => {
		await setup();
		await writeFile(configPath, "{ invalid json");
		await expect(call({ agent: "egm-design", task: "Review", files: [] })).rejects.toThrow();
	});

	test("EGM callers cannot grant a reviewer worker permissions", async () => {
		await setup();
		const result = await call({ agent: "egm-design", task: "Review", role: "worker", files: [] });
		expect(text(result)).toContain("cannot run with worker permissions");
		expect(result).toMatchObject({ isError: true });
	});

	test("non-nesting backend rejects synthesizers with direct-dispatch guidance", async () => {
		await setup();
		const result = await call({ agent: "egm-synthesizer", task: "Coordinate review", files: [] });
		expect(text(result)).toContain("Dispatch EGM leaf reviewers directly");
		expect(result).toMatchObject({ isError: true });
	});

	test("reviewers cannot implicitly read the entire checkout", async () => {
		await setup();
		const result = await call({ agent: "egm-design", task: "Review everything" });
		expect(text(result)).toMatch(/files|explicit/i);
		expect(result).toMatchObject({ isError: true });
	});

	test("a delegated cwd cannot expose host files outside the session workspace", async () => {
		await setup();
		const result = await call({ agent: "egm-design", task: "Read host files", cwd: tmpdir(), files: [] });
		expect(result).toMatchObject({ isError: true });
		expect(text(result)).toContain("cwd must stay inside the session workspace");
	});

	test("sandbox startup failure returns an error without executing the task on the host", async () => {
		await setup();
		const marker = join(directory, "must-not-exist");
		const result = await call({ agent: "egm-design", task: `Write a file at ${marker}`, files: [] });
		expect(result).toMatchObject({ isError: true });
		expect(text(result)).toMatch(/ENOENT|spawn|sandbox/i);
		expect(existsSync(marker)).toBe(false);
	});

	test("network configuration cannot accidentally grant wildcard egress", async () => {
		await writeFile(
			configPath,
			JSON.stringify({
				executable: process.execPath,
				template: "pi-test:1",
				piCommand: "/opt/pi",
				networkAllow: ["**"],
			}),
		);
		expect(() => loadSandboxConfig(configPath)).toThrow(/wildcards/);
	});
});
