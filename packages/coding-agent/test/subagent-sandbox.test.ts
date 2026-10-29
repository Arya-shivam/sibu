import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSandbox, type SandboxConfig, type SandboxRequest } from "../examples/extensions/subagent/sandbox.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill = vi.fn(() => {
		queueMicrotask(() => this.emit("close", null, "SIGKILL"));
		return true;
	});
}

const complete = `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reviewed" }] } })}\n${JSON.stringify({ type: "agent_end", messages: [] })}\n`;
let calls: string[][];
let payload:
	| {
			path: string;
			system: string;
			task: string;
			auth?: string;
			resource?: string;
			unrelated?: boolean;
			git?: boolean;
	  }
	| undefined;
let respond: (args: string[], child: FakeChild) => boolean;
const config: SandboxConfig = {
	executable: "/private/sbx",
	template: "pi-delegation:1.4.0",
	piCommand: "/home/agent/pi-runtime/node_modules/.bin/pi",
	cpus: 2,
	memory: "2g",
	timeoutMs: 10_000,
	networkAllow: ["chatgpt.com"],
};
function request(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
	return {
		workspace: {
			path: "/private/staging",
			repositoryRoot: "/host/repo",
			role: "reviewer",
			mode: "snapshot",
			cleanup: async () => {},
		},
		agentName: "reviewer",
		task: "Review /host/repo/src/main.ts",
		systemPrompt: "Read /host/repo/README.md",
		model: "anthropic/claude-sonnet-4-6",
		tools: ["read", "grep", "find", "ls"],
		...overrides,
	};
}

beforeEach(() => {
	calls = [];
	payload = undefined;
	respond = () => false;
	spawnMock.mockReset();
	spawnMock.mockImplementation((_executable: string, args: string[]) => {
		calls.push(args);
		const child = new FakeChild();
		queueMicrotask(() => {
			if (respond(args, child)) return;
			if (args[0] === "cp") {
				payload = {
					path: args[1],
					system: readFileSync(`${args[1]}/system.txt`, "utf8"),
					task: readFileSync(`${args[1]}/task.txt`, "utf8"),
				};
				if (existsSync(`${args[1]}/auth.json`)) payload.auth = readFileSync(`${args[1]}/auth.json`, "utf8");
				if (existsSync(`${args[1]}/egm/resources/guide.txt`)) {
					payload.resource = readFileSync(`${args[1]}/egm/resources/guide.txt`, "utf8");
					payload.unrelated = existsSync(`${args[1]}/egm/private.json`);
					payload.git = existsSync(`${args[1]}/egm/agents/.git`);
				}
			}
			if (args[0] === "exec" && args.at(-1) === "pwd") child.stdout.write("/guest/workspace\n");
			if (args.includes("--mode")) child.stdout.write(complete);
			child.emit("close", 0, null);
		});
		return child;
	});
});

describe("native sbx subagent execution", () => {
	it("keeps selected review source read-only and removes temporary host payloads", async () => {
		const result = await runSandbox(config, request());
		const create = calls[0];
		expect(create).toContain("/private/staging:ro");
		const primary = create[create.indexOf("shell") + 1];
		expect(primary).toContain("pi-sandbox-primary-");
		expect(primary).not.toBe("/private/staging");
		expect(create[create.indexOf("shell") + 2]).toBe("/private/staging:ro");
		expect(existsSync(primary)).toBe(false);
		expect(create).not.toContain("/host/repo");
		expect(calls.find((args) => args[0] === "policy")).toEqual([
			"policy",
			"allow",
			"network",
			"--sandbox",
			result.sandboxName,
			"chatgpt.com",
		]);
		expect(calls).toContainEqual([
			"policy",
			"rm",
			"network",
			"--sandbox",
			result.sandboxName,
			"--resource",
			"chatgpt.com",
			"--force",
		]);
		expect(payload && existsSync(payload.path)).toBe(false);
		expect(calls.slice(-2)).toEqual([
			["stop", result.sandboxName],
			["rm", "--force", result.sandboxName],
		]);
	});

	it("maps an original dispatch subdirectory to the actual mounted guest cwd", async () => {
		await runSandbox(config, request({ sourceCwd: "/host/repo/src", task: "Review /host/repo/src/main.ts" }));
		expect(payload?.task).toBe("Review /guest/workspace/main.ts");
	});

	it("copies only EGM agents/resources, excludes Git administration and remaps host references", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-egm-test-"));
		try {
			mkdirSync(join(root, "agents", ".git"), { recursive: true });
			mkdirSync(join(root, "resources"));
			writeFileSync(join(root, "agents", "reviewer.md"), "Reviewer persona");
			writeFileSync(join(root, "resources", "guide.txt"), "Review guide");
			writeFileSync(join(root, "private.json"), "not selected");
			await runSandbox({ ...config, egmRoot: root }, request({ task: `Read ${root}/resources/guide.txt` }));
			expect(payload?.resource).toBe("Review guide");
			expect(payload?.unrelated).toBe(false);
			expect(payload?.git).toBe(false);
			expect(payload?.task).toMatch(/^Read \/tmp\/pi-delegation-.*\/egm\/resources\/guide.txt$/);
			expect(payload?.system).toContain("Read referenced resources there using the read tool");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		"not JSON\n",
		'{"type":"agent_end"}\n',
		'{"hello":true}\n',
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider rejected request" } })}\n`,
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "unfinished review" }] } })}\n${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
	])("rejects malformed, incomplete and failed streams: %s", async (stdout) => {
		respond = (args, child) => {
			if (!args.includes("--mode")) return false;
			child.stdout.write(stdout);
			child.emit("close", 0, null);
			return true;
		};
		await expect(runSandbox(config, request())).rejects.toThrow(/Sandbox pi-reviewer-/);
		expect(calls.slice(-2).map((args) => args[0])).toEqual(["stop", "rm"]);
	});

	it("rejects guest exit failures and still removes the sandbox", async () => {
		respond = (args, child) => {
			if (!args.includes("--mode")) return false;
			child.stderr.write("guest failed");
			child.emit("close", 42, null);
			return true;
		};
		await expect(runSandbox(config, request())).rejects.toThrow(/exit 42.*guest failed/);
		expect(calls.at(-1)?.[0]).toBe("rm");
	});

	it("tears down on copy/setup failures", async () => {
		respond = (args, child) => {
			if (args[0] !== "cp") return false;
			child.stderr.write("copy denied");
			child.emit("close", 1, null);
			return true;
		};
		await expect(runSandbox(config, request())).rejects.toThrow("copy denied");
		expect(calls.slice(-2).map((args) => args[0])).toEqual(["stop", "rm"]);
	});

	it("does not append cleanup failures when rejected creation left no registered sandbox", async () => {
		respond = (args, child) => {
			if (args[0] === "create") {
				child.stderr.write("primary workspace validation rejected");
			} else if (args[0] === "stop" || args[0] === "rm") {
				child.stderr.write("sandbox pi-reviewer-test not found");
			} else return false;
			child.emit("close", 1, null);
			return true;
		};
		const result = runSandbox(config, request());
		await expect(result).rejects.toThrow("primary workspace validation rejected");
		await expect(result).rejects.not.toThrow("cleanup failed");
		const primary = calls[0][calls[0].indexOf("shell") + 1];
		expect(existsSync(primary)).toBe(false);
	});

	it("fails rather than running in scratch when the secondary mount cannot be resolved", async () => {
		respond = (args, child) => {
			if (args[0] !== "exec" || !args.includes("--workdir") || args.at(-1) !== "pwd") return false;
			child.stderr.write("selected directory missing");
			child.emit("close", 1, null);
			return true;
		};
		await expect(runSandbox(config, request())).rejects.toThrow("selected directory missing");
		expect(calls.some((args) => args.includes("--mode"))).toBe(false);
		expect(calls.slice(-2).map((args) => args[0])).toEqual(["stop", "rm"]);
	});

	it("does not report success when sandbox removal fails", async () => {
		respond = (args, child) => {
			if (args[0] !== "rm") return false;
			child.stderr.write("daemon unavailable");
			child.emit("close", 1, null);
			return true;
		};
		await expect(runSandbox(config, request())).rejects.toThrow(/cleanup failed.*remove.*daemon unavailable/);
	});

	it("rejects pre-aborted requests before spawning or creating files", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		await expect(runSandbox(config, request({ signal: controller.signal }))).rejects.toThrow("already cancelled");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("stops and removes the guest after cancellation, not merely its exec client", async () => {
		const controller = new AbortController();
		respond = (args) => {
			if (!args.includes("--mode")) return false;
			controller.abort(new Error("user cancelled"));
			return true;
		};
		await expect(runSandbox(config, request({ signal: controller.signal }))).rejects.toThrow(/cancelled/);
		expect(calls.slice(-2).map((args) => args[0])).toEqual(["stop", "rm"]);
	});

	it("applies the overall deadline to hung guest execution and tears it down", async () => {
		respond = (args) => args.includes("--mode");
		await expect(runSandbox({ ...config, timeoutMs: 100 }, request())).rejects.toThrow(/deadline exceeded/);
		expect(calls.slice(-2).map((args) => args[0])).toEqual(["stop", "rm"]);
	});

	it("cleans up a sandbox registered while cancellation interrupts creation", async () => {
		const controller = new AbortController();
		respond = (args, child) => {
			if (args[0] !== "create") return false;
			controller.abort(new Error("cancel create"));
			queueMicrotask(() => child.emit("close", 0, null));
			return true;
		};
		await expect(runSandbox(config, request({ signal: controller.signal }))).rejects.toThrow(/cancel create/);
		expect(calls.slice(-2).map((args) => args[0])).toEqual(["stop", "rm"]);
		expect(calls.some((args) => args.includes("--mode"))).toBe(false);
	});

	it("bounds guest output and cleans up overflow", async () => {
		respond = (args, child) => {
			if (!args.includes("--mode")) return false;
			child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 65));
			return true;
		};
		await expect(runSandbox(config, request())).rejects.toThrow("stdout exceeded 4 MiB");
		expect(calls.at(-1)?.[0]).toBe("rm");
	});

	it("rejects unsafe reviewer tools and unscoped/wildcard allow patterns", async () => {
		await expect(runSandbox(config, request({ tools: ["bash"] }))).rejects.toThrow("non-read-only reviewer tools");
		await expect(runSandbox({ ...config, networkAllow: ["**"] }, request())).rejects.toThrow("exact hostnames");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("supports Codex with sandbox-scoped host broker and only a synthetic guest OAuth token", async () => {
		const command = '"C:/private/pi.exe" auth print-bearer-token --provider openai-codex';
		await runSandbox(
			{ ...config, codexProxy: { command, accountId: "account-test" } },
			request({ model: "openai-codex/gpt-6-luna" }),
		);
		const broker = calls.find((args) => args[0] === "secret");
		expect(broker).toEqual([
			"secret",
			"set",
			"openai",
			"--sandbox",
			expect.stringMatching(/^pi-reviewer-/),
			"--command",
			command,
			"--refresh",
			"on-demand",
		]);
		expect(calls).toContainEqual(["secret", "rm", "openai", "--sandbox", broker?.[4], "--force"]);
		const auth = JSON.parse(payload?.auth ?? "{}");
		expect(auth["openai-codex"]).toMatchObject({
			type: "oauth",
			refresh: "proxy-managed",
			accountId: "account-test",
		});
		const claims = JSON.parse(Buffer.from(auth["openai-codex"].access.split(".")[1], "base64").toString("utf8"));
		expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe("account-test");
		expect(calls.some((args) => args.includes("--token"))).toBe(false);
	});

	it("fails Codex explicitly instead of importing host auth or downgrading to API keys", async () => {
		await expect(runSandbox(config, request({ model: "openai-codex/gpt-6-luna" }))).rejects.toThrow(
			"codexProxy.command",
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("withholds potentially secret resolver diagnostics", async () => {
		respond = (args, child) => {
			if (args[0] !== "secret") return false;
			child.stderr.write("secret-access-token");
			child.emit("close", 1, null);
			return true;
		};
		const result = runSandbox(
			{
				...config,
				codexProxy: {
					command: "/private/pi auth print-bearer-token --provider openai-codex",
					accountId: "account-test",
				},
			},
			request({ model: "openai-codex/gpt-6-luna" }),
		);
		await expect(result).rejects.toThrow("resolver output withheld");
		await expect(result).rejects.not.toThrow("secret-access-token");
	});
});
