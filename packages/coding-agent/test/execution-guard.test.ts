import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type {
	ExecutionGuardEvent,
	ExecutionGuardEventResult,
	ExtensionAPI,
	ExtensionFactory,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

let directory: string;
let session: AgentSession | undefined;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-execution-guard-"));
});
afterEach(async () => {
	session?.dispose();
	session = undefined;
	await rm(directory, { recursive: true, force: true });
});

async function setup(factories: ExtensionFactory[]) {
	const extensionsResult = await createTestExtensionsResult(factories, directory);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	session = new AgentSession({
		agent: new Agent({ streamFn: getModelRuntime(registry).streamSimple.bind(getModelRuntime(registry)) }),
		sessionManager: SessionManager.inMemory(directory),
		settingsManager: SettingsManager.inMemory(),
		cwd: directory,
		modelRuntime: getModelRuntime(registry),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	await session.bindExtensions({});
	return session;
}

const writeMarker = 'require("node:fs").writeFileSync(process.argv[1], "executed")';

describe("execution guard supported API boundaries", () => {
	test("denies extension commands before process effects and preserves explicit reasons", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		await setup([
			(pi) => {
				exec = pi.exec;
				pi.on("execution_guard", () => ({ block: true, reason: "Forbidden command" }));
			},
		]);
		const marker = join(directory, "blocked.txt");
		await expect(exec!(process.execPath, ["-e", writeMarker, marker])).rejects.toThrow("Forbidden command");
		expect(existsSync(marker)).toBe(false);
	});

	test("executes the approved argument snapshot rather than a retained mutable array", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		const approved = join(directory, "approved.txt");
		const redirected = join(directory, "redirected.txt");
		const args = ["-e", writeMarker, approved];
		await setup([
			(pi) => {
				exec = pi.exec;
				pi.on("execution_guard", ({ execution }) => {
					if (execution.kind === "exec") args[2] = redirected;
				});
			},
		]);
		const result = await exec!(process.execPath, args);
		expect(result.code).toBe(0);
		expect(await readFile(approved, "utf8")).toBe("executed");
		expect(existsSync(redirected)).toBe(false);
	});

	test("fails closed when a policy throws", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		await setup([
			(pi) => {
				exec = pi.exec;
				pi.on("execution_guard", () => {
					throw new Error("Policy failed");
				});
			},
		]);
		await expect(exec!(process.execPath, ["-e", writeMarker, join(directory, "failed.txt")])).rejects.toThrow(
			"Policy failed",
		);
		expect(existsSync(join(directory, "failed.txt"))).toBe(false);
	});

	test.each([null, true, { block: "yes" }, { reason: 7 }, { command: "rewritten" }])(
		"fails closed for malformed policy decision %j",
		async (decision) => {
			let exec: ExtensionAPI["exec"] | undefined;
			await setup([
				(pi) => {
					exec = pi.exec;
					pi.on("execution_guard", () => decision as unknown as ExecutionGuardEventResult);
				},
			]);
			const marker = join(directory, "invalid.txt");
			await expect(exec!(process.execPath, ["-e", writeMarker, marker])).rejects.toThrow();
			expect(existsSync(marker)).toBe(false);
		},
	);

	test("guards cannot rewrite nested execution arguments", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		await setup([
			(pi) => {
				exec = pi.exec;
				pi.on("execution_guard", ({ execution }) => {
					if (execution.kind === "exec") Reflect.set(execution.args, 2, join(directory, "redirected.txt"));
				});
			},
		]);
		const approved = join(directory, "approved.txt");
		await exec!(process.execPath, ["-e", writeMarker, approved]);
		expect(await readFile(approved, "utf8")).toBe("executed");
		expect(existsSync(join(directory, "redirected.txt"))).toBe(false);
	});

	test("does not spawn after cancellation while authorization is pending", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		const controller = new AbortController();
		await setup([
			(pi) => {
				exec = pi.exec;
				pi.on("execution_guard", () => {
					controller.abort();
				});
			},
		]);
		const marker = join(directory, "cancelled.txt");
		await expect(
			exec!(process.execPath, ["-e", writeMarker, marker], { signal: controller.signal }),
		).rejects.toThrow();
		expect(existsSync(marker)).toBe(false);
	});

	test("guard policies cannot launch recursive pi.exec commands", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		await setup([
			(pi) => {
				exec = pi.exec;
				pi.on("execution_guard", async () => {
					await pi.exec(process.execPath, ["-e", writeMarker, join(directory, "recursive.txt")]);
				});
			},
		]);
		await expect(exec!(process.execPath, ["-e", writeMarker, join(directory, "outer.txt")])).rejects.toThrow();
		expect(existsSync(join(directory, "recursive.txt"))).toBe(false);
		expect(existsSync(join(directory, "outer.txt"))).toBe(false);
	});

	test("user shell denial runs before even custom execution backends", async () => {
		let backendCalled = false;
		let observed: ExecutionGuardEvent["execution"] | undefined;
		const active = await setup([
			(pi) => {
				pi.on("execution_guard", ({ execution }) => {
					observed = execution;
					return { block: true, reason: "Shell denied" };
				});
			},
		]);
		active.settingsManager.applyOverrides({ shellCommandPrefix: "echo prefix" });
		await expect(
			active.executeBash("echo original", undefined, {
				operations: {
					exec: async () => {
						backendCalled = true;
						return { exitCode: 0 };
					},
				},
			}),
		).rejects.toThrow("Shell denied");
		expect(backendCalled).toBe(false);
		expect(observed).toMatchObject({ kind: "user_bash", command: "echo prefix\necho original", cwd: directory });
		expect(active.isBashRunning).toBe(false);
	});

	test("allowed extension execution preserves output, exit code and cwd", async () => {
		let exec: ExtensionAPI["exec"] | undefined;
		await setup([
			(pi) => {
				exec = pi.exec;
			},
		]);
		const result = await exec!(
			process.execPath,
			["-e", 'console.log(process.cwd()); console.error("err"); process.exitCode = 7'],
			{ cwd: directory },
		);
		expect(result).toMatchObject({ code: 7, killed: false, stderr: expect.stringContaining("err") });
		expect(result.stdout.trim().toLowerCase()).toBe(directory.toLowerCase());
	});
});
