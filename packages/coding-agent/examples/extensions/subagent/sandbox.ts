import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PreparedWorkspace } from "./workspace.ts";

export interface SandboxConfig {
	executable: string;
	template: string;
	piCommand: string;
	cpus: number;
	memory: string;
	timeoutMs: number;
	networkAllow: string[];
	egmRoot?: string;
	/** Trusted host command outside writable mounts; prints only the current Codex access token. */
	codexProxy?: { command: string; accountId: string };
}

export interface SandboxRequest {
	workspace: PreparedWorkspace;
	/** Original dispatch cwd, needed when only a repository subtree is mounted. */
	sourceCwd?: string;
	agentName: string;
	systemPrompt: string;
	task: string;
	model?: string;
	thinkingLevel?: string;
	tools: string[];
	signal?: AbortSignal;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface SandboxResult {
	exitCode: number;
	sandboxName: string;
	stdout: string;
	stderr: string;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;
const CLEANUP_TIMEOUT = 30_000;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Never uses a shell or inherits stdin; broker diagnostics are withheld. */
function command(
	executable: string,
	args: string[],
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		onStdout?: (chunk: string) => void;
		onStderr?: (chunk: string) => void;
		sensitive?: boolean;
	} = {},
): Promise<CommandResult> {
	options.signal?.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let failure: Error | undefined;
	let stdoutBytes = 0;
	let stderrBytes = 0;
	const outDecoder = new StringDecoder("utf8");
	const errDecoder = new StringDecoder("utf8");
	const fail = (error: Error) => {
		failure ??= error;
		child.kill("SIGKILL");
	};
	const abort = () => fail(new Error(`Sandbox operation cancelled: ${describe(options.signal?.reason)}`));
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => fail(new Error("Sandbox CLI deadline exceeded")), options.timeoutMs);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	child.stdout.on("data", (data: Buffer) => {
		stdoutBytes += data.length;
		if (stdoutBytes > STDOUT_LIMIT) return fail(new Error("Sandbox stdout exceeded 4 MiB limit"));
		const text = outDecoder.write(data);
		stdout += text;
		try {
			options.onStdout?.(text);
		} catch (error) {
			fail(new Error(`Sandbox stdout callback failed: ${describe(error)}`));
		}
	});
	child.stderr.on("data", (data: Buffer) => {
		stderrBytes += data.length;
		if (stderrBytes > STDERR_LIMIT) return fail(new Error("Sandbox stderr exceeded 256 KiB limit"));
		const text = errDecoder.write(data);
		stderr += text;
		try {
			options.onStderr?.(text);
		} catch (error) {
			fail(new Error(`Sandbox stderr callback failed: ${describe(error)}`));
		}
	});
	child.on("error", (error) => {
		failure ??= error;
	});
	child.on("close", (code, signal) => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		stdout += outDecoder.end();
		stderr += errDecoder.end();
		if (failure) reject(failure);
		else if (code === null) reject(new Error(`Sandbox CLI terminated by ${signal ?? "unknown signal"}`));
		else if (code !== 0)
			reject(
				new Error(
					options.sensitive
						? `Sandbox credential broker operation failed (exit ${code}); resolver output withheld`
						: `sbx ${args[0]} failed (exit ${code}): ${(stderr || stdout).slice(-8192)}`,
				),
			);
		else resolve({ code, stdout, stderr });
	});
	return promise;
}

async function copyResources(source: string, destination: string, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const root = await realpath(source);
	async function inspect(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			signal.throwIfAborted();
			if (entry.name === ".git") continue;
			if (directory === root && entry.name !== "agents" && entry.name !== "resources") continue;
			const filename = path.join(directory, entry.name);
			const stat = await lstat(filename);
			if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
				throw new Error(`EGM resources must contain only regular files/directories: ${filename}`);
			}
			if (stat.isDirectory()) await inspect(filename);
		}
	}
	if ((await lstat(source)).isSymbolicLink()) throw new Error("EGM root must not be a symbolic link");
	await inspect(root);
	await cp(root, destination, {
		recursive: true,
		dereference: false,
		filter: (filename) => {
			if (path.basename(filename) === ".git") return false;
			const relative = path.relative(root, filename);
			const top = relative.split(path.sep)[0];
			return !relative || top === "agents" || top === "resources";
		},
	});
	signal.throwIfAborted();
}

function remap(text: string, source: string, destination: string): string {
	const forms = new Set([source, source.replaceAll("\\", "/"), source.replaceAll("/", "\\")]);
	for (const form of forms) if (form) text = text.split(form).join(destination);
	return text;
}

function validateStream(stdout: string): void {
	let assistant = false;
	let ended = false;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error(`Malformed Pi JSON stream: ${line.slice(0, 160)}`);
		}
		if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") {
			throw new Error("Malformed Pi JSON event: missing type");
		}
		if (event.type === "agent_end") ended = true;
		if (event.type === "message_end" && "message" in event && event.message && typeof event.message === "object") {
			const message = event.message;
			if ("role" in message && message.role === "assistant") {
				if ("errorMessage" in message && message.errorMessage)
					throw new Error(`Guest Pi failed: ${String(message.errorMessage).slice(0, 4096)}`);
				if (!("stopReason" in message) || (message.stopReason !== "stop" && message.stopReason !== "toolUse")) {
					throw new Error("Guest Pi assistant failed, was aborted, or ended before completing its response");
				}
				assistant = message.stopReason !== "toolUse";
			}
		}
	}
	if (!assistant || !ended)
		throw new Error("Incomplete Pi JSON stream: expected completed assistant message and agent_end");
}

/** Creates and destroys one local sandbox. Workspaces are retained/removed by the caller. */
export async function runSandbox(config: SandboxConfig, request: SandboxRequest): Promise<SandboxResult> {
	request.signal?.throwIfAborted();
	if (
		!config.executable ||
		!config.template ||
		!config.piCommand ||
		!Number.isInteger(config.cpus) ||
		config.cpus < 1 ||
		!config.memory ||
		!Number.isFinite(config.timeoutMs) ||
		config.timeoutMs <= 0
	) {
		throw new Error(
			"Invalid sandbox configuration: executable, saved template, Pi command, CPU/memory and positive deadline are required",
		);
	}
	for (const host of config.networkAllow) {
		if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+(?::[0-9]{1,5})?$/i.test(host)) {
			throw new Error(`networkAllow requires exact hostnames, optionally with a port: ${host}`);
		}
	}
	const codex = request.model?.startsWith("openai-codex/") === true;
	if (codex && (!config.codexProxy?.command.trim() || !config.codexProxy.accountId.trim())) {
		throw new Error(
			"openai-codex requires codexProxy.command (trusted absolute host Pi auth print-bearer-token command outside writable mounts) and codexProxy.accountId; no host auth is copied and OPENAI_API_KEY is not Codex OAuth",
		);
	}
	const allowedTools =
		request.workspace.role === "reviewer"
			? ["read", "grep", "find", "ls"]
			: ["read", "grep", "find", "ls", "bash", "edit", "write"];
	if (request.tools.some((tool) => !allowedTools.includes(tool)))
		throw new Error("Sandbox tools contain unsupported or non-read-only reviewer tools");
	const sandboxName = `pi-${request.agentName.replace(/[^a-z0-9-]/gi, "-").slice(0, 32)}-${randomUUID()}`;
	const controller = new AbortController();
	const abort = () => controller.abort(request.signal?.reason ?? new Error("Sandbox cancelled"));
	request.signal?.addEventListener("abort", abort, { once: true });
	if (request.signal?.aborted) abort();
	const deadlineAt = Date.now() + config.timeoutMs;
	const deadline = setTimeout(
		() => controller.abort(new Error(`Sandbox deadline exceeded (${config.timeoutMs} ms)`)),
		config.timeoutMs,
	);
	const run = (
		args: string[],
		options: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; sensitive?: boolean } = {},
	) => command(config.executable, args, { ...options, signal: controller.signal });
	let staging: string | undefined;
	let reviewerPrimary: string | undefined;
	let attemptedCreate = false;
	let result: SandboxResult | undefined;
	let failure: unknown;
	let cancellationStop: Promise<void> | undefined;
	const attemptedNetworkHosts: string[] = [];
	let attemptedSecret = false;
	const stopOnAbort = () => {
		if (attemptedCreate) {
			// Retry stop during final teardown if creation has not registered yet.
			cancellationStop = command(config.executable, ["stop", sandboxName], { timeoutMs: CLEANUP_TIMEOUT }).then(
				() => {},
				() => {},
			);
		}
	};
	controller.signal.addEventListener("abort", stopOnAbort, { once: true });
	try {
		controller.signal.throwIfAborted();
		staging = await mkdtemp(path.join(tmpdir(), "pi-sandbox-payload-"));
		controller.signal.throwIfAborted();
		if (request.workspace.role === "reviewer") {
			// sbx requires its primary workspace to be writable. Only this empty,
			// disposable directory is writable; selected review files are secondary RO.
			reviewerPrimary = await mkdtemp(path.join(tmpdir(), "pi-sandbox-primary-"));
			controller.signal.throwIfAborted();
		}
		const guestPayload = `/tmp/pi-delegation-${randomUUID()}`;
		attemptedCreate = true;
		// Let creation settle before cleanup: killing its client can leave a late daemon-side registration.
		await command(
			config.executable,
			[
				"create",
				"--name",
				sandboxName,
				"--template",
				config.template,
				"--pull",
				"never",
				"--skills",
				"off",
				"--cpus",
				String(config.cpus),
				"--memory",
				config.memory,
				"--no-progress",
				"shell",
				...(reviewerPrimary ? [reviewerPrimary, `${request.workspace.path}:ro`] : [request.workspace.path]),
			],
			{ timeoutMs: Math.max(1, deadlineAt - Date.now()) },
		);
		controller.signal.throwIfAborted();
		for (const host of config.networkAllow) {
			attemptedNetworkHosts.push(host);
			await run(["policy", "allow", "network", "--sandbox", sandboxName, host]);
		}
		if (codex && config.codexProxy) {
			attemptedSecret = true;
			await run(
				[
					"secret",
					"set",
					"openai",
					"--sandbox",
					sandboxName,
					"--command",
					config.codexProxy.command,
					"--refresh",
					"on-demand",
				],
				{ sensitive: true },
			);
			// Pi validates JWT shape locally. This unsigned placeholder is not a credential:
			// sbx replaces Authorization on the host; only the non-secret account ID is needed locally.
			const token = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: config.codexProxy.accountId } })).toString("base64")}.proxy-managed`;
			await writeFile(
				path.join(staging, "auth.json"),
				JSON.stringify({
					"openai-codex": {
						type: "oauth",
						access: token,
						refresh: "proxy-managed",
						expires: Date.now() + config.timeoutMs + 86_400_000,
						accountId: config.codexProxy.accountId,
					},
				}),
				{ mode: 0o600 },
			);
		}
		let pwd = (await run(["exec", sandboxName, "pwd"])).stdout.trim();
		if (!pwd.startsWith("/") || pwd.includes("\n") || pwd === "/")
			throw new Error(`Invalid guest workspace path from sbx exec pwd: ${pwd}`);
		if (reviewerPrimary) {
			const primaryRoot = path.parse(reviewerPrimary).root;
			const selectedRoot = path.parse(path.resolve(request.workspace.path)).root;
			let selectedGuest: string;
			if (primaryRoot.toLowerCase() === selectedRoot.toLowerCase()) {
				const relative = path.relative(reviewerPrimary, request.workspace.path).split(path.sep).join("/");
				selectedGuest = path.posix.resolve(pwd, relative);
			} else {
				const drivePath = /^([a-z]):[\\/](.*)$/i.exec(request.workspace.path);
				if (!drivePath)
					throw new Error("Unsupported secondary workspace root; use a local absolute drive or POSIX path");
				selectedGuest = `/${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll("\\", "/")}`;
			}
			// Resolve through a real guest exec, rather than treating host paths as guest cwd.
			pwd = (await run(["exec", "--workdir", selectedGuest, sandboxName, "pwd"])).stdout.trim();
			if (!pwd.startsWith("/") || pwd.includes("\n") || pwd === "/")
				throw new Error(`Invalid secondary guest workspace path: ${pwd}`);
		}
		let task = request.task;
		let prompt = request.systemPrompt;
		if (config.egmRoot) {
			await copyResources(config.egmRoot, path.join(staging, "egm"), controller.signal);
			task = remap(task, config.egmRoot, `${guestPayload}/egm`);
			prompt = remap(prompt, config.egmRoot, `${guestPayload}/egm`);
			prompt += `\nEGM personas and resources are copied to ${guestPayload}/egm. Read referenced resources there using the read tool; host EGM paths are unavailable.\n`;
		}
		if (request.sourceCwd) {
			task = remap(task, request.sourceCwd, pwd);
			prompt = remap(prompt, request.sourceCwd, pwd);
		}
		task = remap(task, request.workspace.path, pwd);
		prompt = remap(prompt, request.workspace.path, pwd);
		task = remap(task, request.workspace.repositoryRoot, pwd);
		prompt = remap(prompt, request.workspace.repositoryRoot, pwd);
		prompt += `\nWorkspace: ${pwd}. This is an isolated ${request.workspace.role} ${request.workspace.mode}; no host home or authentication is mounted. ${request.workspace.mode === "worktree" ? "This worktree starts at HEAD and does not include original dirty changes. Do not commit or merge automatically." : ""}\n`;
		await writeFile(path.join(staging, "system.txt"), prompt, { mode: 0o600 });
		await writeFile(path.join(staging, "task.txt"), task, { mode: 0o600 });
		await run(["cp", staging, `${sandboxName}:${guestPayload}`]);
		// sbx cp writes root-owned files; repair ownership before running Pi as the unprivileged agent.
		await run(["exec", "--user", "root", sandboxName, "chown", "-R", "agent:agent", guestPayload]);
		await run(["exec", sandboxName, "chmod", "-R", "u+rwX,go-rwx", guestPayload]);
		await run(["exec", sandboxName, "mkdir", "-m", "700", `${guestPayload}/agent`]);
		if (codex) await run(["exec", sandboxName, "mv", `${guestPayload}/auth.json`, `${guestPayload}/agent/auth.json`]);
		const args = [
			"exec",
			"--workdir",
			pwd,
			"--env",
			`PI_CODING_AGENT_DIR=${guestPayload}/agent`,
			sandboxName,
			config.piCommand,
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-context-files",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
			"--append-system-prompt",
			`${guestPayload}/system.txt`,
		];
		if (request.model) args.push("--model", request.model);
		if (request.thinkingLevel) args.push("--thinking", request.thinkingLevel);
		if (request.tools.length) args.push("--tools", request.tools.join(","));
		else args.push("--no-tools");
		args.push(`@${guestPayload}/task.txt`, "Perform the task in the attached task.txt exactly as written.");
		const output = await run(args, { onStdout: request.onStdout, onStderr: request.onStderr });
		validateStream(output.stdout);
		result = { exitCode: output.code, sandboxName, stdout: output.stdout, stderr: output.stderr };
	} catch (error) {
		failure = error;
	} finally {
		clearTimeout(deadline);
		request.signal?.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", stopOnAbort);
		await cancellationStop;
		const cleanupErrors: string[] = [];
		if (attemptedSecret) {
			try {
				await command(config.executable, ["secret", "rm", "openai", "--sandbox", sandboxName, "--force"], {
					timeoutMs: CLEANUP_TIMEOUT,
					sensitive: true,
				});
			} catch (error) {
				cleanupErrors.push(`scoped credential: ${describe(error)}`);
			}
		}
		for (const host of attemptedNetworkHosts) {
			try {
				await command(
					config.executable,
					["policy", "rm", "network", "--sandbox", sandboxName, "--resource", host, "--force"],
					{ timeoutMs: CLEANUP_TIMEOUT },
				);
			} catch (error) {
				cleanupErrors.push(`scoped network ${host}: ${describe(error)}`);
			}
		}
		if (attemptedCreate) {
			// Stopping the guest, not just its sbx exec client, kills Pi and detached tools.
			try {
				await command(config.executable, ["stop", sandboxName], { timeoutMs: CLEANUP_TIMEOUT });
			} catch (error) {
				const message = describe(error);
				if (!/(?:sandbox\b[^\n]*\b(?:not found|does not exist)|no such sandbox)\b/i.test(message))
					cleanupErrors.push(`stop: ${message}`);
			}
			try {
				await command(config.executable, ["rm", "--force", sandboxName], { timeoutMs: CLEANUP_TIMEOUT });
			} catch (error) {
				const message = describe(error);
				if (!/(?:sandbox\b[^\n]*\b(?:not found|does not exist)|no such sandbox)\b/i.test(message))
					cleanupErrors.push(`remove: ${message}`);
			}
		}
		if (staging) {
			try {
				await rm(staging, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(`payload removal: ${describe(error)}`);
			}
		}
		if (reviewerPrimary) {
			try {
				await rm(reviewerPrimary, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(`reviewer scratch removal: ${describe(error)}`);
			}
		}
		if (cleanupErrors.length)
			failure = new Error(
				`${failure ? `${describe(failure)}; ` : ""}Sandbox cleanup failed: ${cleanupErrors.join("; ")}`,
			);
	}
	if (failure) throw new Error(`Sandbox ${sandboxName}: ${describe(failure)}`);
	if (!result) throw new Error(`Sandbox ${sandboxName}: no guest result`);
	return result;
}
