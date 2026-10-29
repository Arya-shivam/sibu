import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export type WorkspaceMode = "snapshot" | "worktree";
export type WorkspaceRole = "reviewer" | "worker";

export interface WorkspaceRequest {
	cwd: string;
	role: WorkspaceRole;
	mode: WorkspaceMode;
	files?: string[];
	signal?: AbortSignal;
}

export interface PreparedWorkspace {
	path: string;
	repositoryRoot: string;
	mode: WorkspaceMode;
	role: WorkspaceRole;
	branch?: string;
	cleanup(): Promise<void>;
}

// Bounds also apply to explicitly selected files. No recursive host-directory copies.
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

interface SnapshotFile {
	relativePath: string;
	source: string;
	stat: Stats;
}

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Workspace preparation aborted");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function comparablePath(value: string): string {
	const normalized = path.resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(comparablePath(root), comparablePath(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativeFile(value: string): string {
	if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
		throw new Error(`Workspace files must be nonempty relative paths: ${JSON.stringify(value)}`);
	}
	const parts = value.replaceAll("\\", "/").split("/");
	if (
		parts.some(
			(part) =>
				part === ".." ||
				part.replace(/[. ]+$/, "").toLowerCase() === ".git" ||
				part.toLowerCase() === ".git" ||
				/[<>:"|?*\u0000-\u001f]/.test(part) ||
				(/[. ]$/.test(part) && part !== ".") ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
		)
	) {
		throw new Error(`Unsafe workspace file path (traversal, metadata, or invalid name): ${JSON.stringify(value)}`);
	}
	const normalized = parts.filter((part) => part !== "" && part !== ".").join(path.sep);
	if (!normalized) throw new Error(`Workspace file must name a file: ${JSON.stringify(value)}`);
	return normalized;
}

async function assertNoSymlinks(candidate: string): Promise<Stats> {
	const absolute = path.resolve(candidate);
	const root = path.parse(absolute).root;
	let current = root;
	let stat = await lstat(root);
	for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		stat = await lstat(current);
		if (stat.isSymbolicLink()) throw new Error(`Workspace symlinks are not allowed: ${current}`);
	}
	return stat;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.toUpperCase().startsWith("GIT_")) delete env[name];
	}
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["--no-optional-locks", "-c", "core.hooksPath=", ...args],
			{
				cwd,
				env,
				shell: false,
				windowsHide: true,
				timeout: 30_000,
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				if (error) reject(new Error(`Git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || error.message}`));
				else resolve(stdout);
			},
		);
	});
}

async function repositoryRoot(cwd: string, required: boolean): Promise<string> {
	try {
		const root = path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
		if (!within(root, cwd)) throw new Error(`Workspace cwd is outside Git repository: ${cwd}`);
		return root;
	} catch (error) {
		if (required) throw new Error(`Workspace requires a Git working tree: ${errorMessage(error)}`);
		return cwd;
	}
}

async function collectSnapshotFiles(request: WorkspaceRequest, cwd: string): Promise<SnapshotFile[]> {
	const explicit = request.files !== undefined;
	const names = explicit
		? (request.files ?? [])
		: (await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]))
				.split("\0")
				.filter(Boolean);
	if (names.length > MAX_FILES) throw new Error(`Workspace snapshot exceeds ${MAX_FILES} files`);
	const selected = new Map<string, SnapshotFile>();
	let totalBytes = 0;
	for (const name of names) {
		checkAbort(request.signal);
		const relativePath = relativeFile(name);
		const source = path.resolve(cwd, relativePath);
		if (!within(cwd, source)) throw new Error(`Workspace file escapes cwd: ${name}`);
		if (selected.has(comparablePath(source))) continue;
		let stat: Stats;
		try {
			stat = await assertNoSymlinks(source);
		} catch (error) {
			// A deleted tracked file is absent in the current dirty snapshot, not restored from HEAD.
			if (!explicit && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		if (!stat.isFile())
			throw new Error(`Workspace selection must name regular files, not directories or submodules: ${name}`);
		if (!within(cwd, await realpath(source))) throw new Error(`Workspace file escapes cwd: ${name}`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes: ${name}`);
		totalBytes += stat.size;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Workspace snapshot exceeds ${MAX_TOTAL_BYTES} total bytes`);
		selected.set(comparablePath(source), { relativePath, source, stat });
	}
	return [...selected.values()];
}

async function copySnapshotFile(file: SnapshotFile, destinationRoot: string, signal?: AbortSignal): Promise<void> {
	checkAbort(signal);
	await assertNoSymlinks(file.source);
	const source = await open(file.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await source.stat();
		if (
			!before.isFile() ||
			before.dev !== file.stat.dev ||
			before.ino !== file.stat.ino ||
			before.size !== file.stat.size ||
			before.mtimeMs !== file.stat.mtimeMs
		) {
			throw new Error(`Workspace file changed during snapshot preparation: ${file.relativePath}`);
		}
		const destination = path.join(destinationRoot, file.relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		const target = await open(destination, "wx", before.mode & 0o777);
		try {
			// Bounded chunking prevents a concurrently growing file from exhausting memory or disk.
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size));
			let position = 0;
			while (position < before.size) {
				checkAbort(signal);
				const { bytesRead } = await source.read(
					buffer,
					0,
					Math.min(buffer.length, before.size - position),
					position,
				);
				if (bytesRead === 0) throw new Error(`Workspace file shrank during snapshot: ${file.relativePath}`);
				let written = 0;
				while (written < bytesRead) {
					checkAbort(signal);
					const { bytesWritten } = await target.write(buffer, written, bytesRead - written, position + written);
					if (bytesWritten === 0) throw new Error(`Unable to write workspace file: ${file.relativePath}`);
					written += bytesWritten;
				}
				position += bytesRead;
			}
			const after = await source.stat();
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
				throw new Error(`Workspace file changed during snapshot: ${file.relativePath}`);
			}
		} finally {
			await target.close();
		}
	} finally {
		await source.close();
	}
}

async function prepareSnapshot(request: WorkspaceRequest, cwd: string, root: string): Promise<PreparedWorkspace> {
	const files = await collectSnapshotFiles(request, cwd);
	checkAbort(request.signal);
	const staging = await mkdtemp(path.join(tmpdir(), "pi-subagent-snapshot-"));
	try {
		for (const file of files) await copySnapshotFile(file, staging, request.signal);
		checkAbort(request.signal);
		return {
			path: staging,
			repositoryRoot: root,
			mode: request.mode,
			role: request.role,
			async cleanup() {
				if (request.role === "reviewer") await rm(staging, { recursive: true, force: true });
			},
		};
	} catch (error) {
		try {
			await rm(staging, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new Error(
				`${errorMessage(error)}; snapshot cleanup failed at ${staging}: ${errorMessage(cleanupError)}`,
			);
		}
		throw error;
	}
}

async function prepareWorktree(request: WorkspaceRequest, cwd: string, root: string): Promise<PreparedWorkspace> {
	const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
	const prefix = path.relative(root, cwd).split(path.sep).join("/") || ".";
	const entries = (await git(root, ["ls-tree", "-r", "-z", "--full-tree", head, "--", prefix])).split("\0");
	for (const entry of entries) {
		checkAbort(request.signal);
		if (!entry) continue;
		const separator = entry.indexOf("\t");
		const name = entry.slice(separator + 1);
		relativeFile(name);
		if (entry.startsWith("120000 ")) throw new Error(`Workspace symlinks are not allowed at HEAD: ${name}`);
	}
	checkAbort(request.signal);
	const staging = await mkdtemp(path.join(tmpdir(), "pi-subagent-worktree-"));
	const worktree = path.join(staging, "worktree");
	const branch = `pi-subagent/${randomUUID()}`;
	try {
		checkAbort(request.signal);
		// Do not interrupt Git mid-registration: cancellation is checked immediately afterward and rolled back.
		await git(root, ["worktree", "add", "--no-track", "-b", branch, "--", worktree, head]);
		checkAbort(request.signal);
		const workspacePath = path.join(worktree, path.relative(root, cwd));
		const stat = await assertNoSymlinks(workspacePath);
		if (!stat.isDirectory()) throw new Error(`Requested cwd does not exist at HEAD: ${path.relative(root, cwd)}`);
		checkAbort(request.signal);
		return {
			path: workspacePath,
			repositoryRoot: root,
			mode: "worktree",
			role: "worker",
			branch,
			// Worker outputs and branch are retained. Only the host coordinator may administer Git.
			async cleanup() {},
		};
	} catch (error) {
		const cleanupErrors: string[] = [];
		try {
			const records = (await git(root, ["worktree", "list", "--porcelain", "-z"])).split("\0");
			if (
				records.some(
					(record) =>
						record.startsWith("worktree ") && comparablePath(record.slice(9)) === comparablePath(worktree),
				)
			) {
				// Never force removal: an unexpected file or edit must be retained rather than destroyed.
				await git(root, ["worktree", "remove", "--", worktree]);
			}
			const branchHead = (
				await git(root, ["for-each-ref", "--format=%(objectname)", "--", `refs/heads/${branch}`])
			).trim();
			if (branchHead === head) await git(root, ["branch", "-d", "--", branch]);
			else if (branchHead) throw new Error(`Branch ${branch} changed during setup; retaining it`);
			await rmdir(staging);
		} catch (cleanupError) {
			cleanupErrors.push(`retained workspace ${worktree}, branch ${branch}: ${errorMessage(cleanupError)}`);
		}
		throw new Error(
			`${errorMessage(error)}${cleanupErrors.length ? `; setup cleanup failed: ${cleanupErrors.join("; ")}` : ""}`,
		);
	}
}

export async function prepareWorkspace(request: WorkspaceRequest): Promise<PreparedWorkspace> {
	checkAbort(request.signal);
	if (request.role !== "reviewer" && request.role !== "worker") throw new Error("Unknown workspace role");
	if (request.mode !== "snapshot" && request.mode !== "worktree") throw new Error("Unknown workspace mode");
	if (request.role === "reviewer" && request.mode !== "snapshot")
		throw new Error("Reviewer workspaces must use snapshot mode");
	if (request.role === "reviewer" && request.files === undefined) {
		throw new Error("Reviewer snapshots require an explicit files list (use [] for an empty workspace)");
	}
	if (request.mode === "worktree" && request.files !== undefined) {
		throw new Error(
			"Worktree mode does not accept a file selection; it starts from HEAD, without dirty or untracked checkout changes",
		);
	}
	if (request.files !== undefined) {
		if (!Array.isArray(request.files)) throw new Error("Workspace files must be an array of relative file paths");
		if (request.files.length > MAX_FILES) throw new Error(`Workspace snapshot exceeds ${MAX_FILES} files`);
		for (const file of request.files) relativeFile(file);
	}
	if (typeof request.cwd !== "string" || request.cwd.length === 0) throw new Error("Workspace cwd is required");
	const cwd = path.resolve(request.cwd);
	const stat = await assertNoSymlinks(cwd);
	if (!stat.isDirectory()) throw new Error(`Workspace cwd must be a directory: ${cwd}`);
	if (
		path
			.relative(path.parse(cwd).root, cwd)
			.split(path.sep)
			.some((part) => part.replace(/[. ]+$/, "").toLowerCase() === ".git")
	) {
		throw new Error("Workspace cwd must not be inside Git metadata");
	}
	const root = await repositoryRoot(cwd, request.mode === "worktree" || request.files === undefined);
	checkAbort(request.signal);
	return request.mode === "worktree" ? prepareWorktree(request, cwd, root) : prepareSnapshot(request, cwd, root);
}
