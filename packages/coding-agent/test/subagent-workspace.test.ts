import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PreparedWorkspace, prepareWorkspace } from "../examples/extensions/subagent/workspace.ts";

const cleanupPaths: string[] = [];

function git(cwd: string, args: string[], input?: string): string {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.toUpperCase().startsWith("GIT_")) delete env[name];
	}
	return execFileSync("git", args, { cwd, env, input, shell: false, windowsHide: true, encoding: "utf8" }).trim();
}

function directory(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-workspace-test-"));
	cleanupPaths.push(dir);
	return dir;
}

function repository(): string {
	const dir = directory();
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.name", "Workspace Test"]);
	git(dir, ["config", "user.email", "workspace@example.invalid"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["config", "core.autocrlf", "false"]);
	git(dir, ["config", "core.eol", "lf"]);
	writeFileSync(path.join(dir, "shared.txt"), "committed\n");
	mkdirSync(path.join(dir, "nested"));
	writeFileSync(path.join(dir, "nested", "design.txt"), "design\n");
	writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
	git(dir, ["add", "--", "shared.txt", "nested/design.txt", ".gitignore"]);
	git(dir, ["-c", "core.hooksPath=", "commit", "-m", "Fixture"]);
	return dir;
}

function retainForTestCleanup(workspace: PreparedWorkspace): PreparedWorkspace {
	cleanupPaths.push(
		workspace.mode === "worktree"
			? path.dirname(git(workspace.path, ["rev-parse", "--show-toplevel"]))
			: workspace.path,
	);
	return workspace;
}

afterEach(() => {
	for (const dir of cleanupPaths.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("isolated subagent workspaces", () => {
	it("creates independent HEAD worktrees and retains edits without touching dirty main files", async () => {
		const cwd = repository();
		writeFileSync(path.join(cwd, "shared.txt"), "user dirty\n");
		writeFileSync(path.join(cwd, "untracked.txt"), "user untracked\n");
		const originalStatus = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
		const [first, second] = await Promise.all([
			prepareWorkspace({ cwd, role: "worker", mode: "worktree" }).then(retainForTestCleanup),
			prepareWorkspace({ cwd, role: "worker", mode: "worktree" }).then(retainForTestCleanup),
		]);
		expect(first.branch).toMatch(/^pi-subagent\//);
		expect(second.branch).not.toBe(first.branch);
		expect(first.path).not.toBe(second.path);
		expect(first.repositoryRoot).toBe(cwd);
		expect(readFileSync(path.join(first.path, "shared.txt"), "utf8")).toBe("committed\n");
		expect(existsSync(path.join(first.path, "untracked.txt"))).toBe(false);
		writeFileSync(path.join(first.path, "shared.txt"), "worker one\n");
		writeFileSync(path.join(second.path, "shared.txt"), "worker two\n");
		await first.cleanup();
		await second.cleanup();
		expect(readFileSync(path.join(first.path, "shared.txt"), "utf8")).toBe("worker one\n");
		expect(readFileSync(path.join(second.path, "shared.txt"), "utf8")).toBe("worker two\n");
		expect(readFileSync(path.join(cwd, "shared.txt"), "utf8")).toBe("user dirty\n");
		expect(readFileSync(path.join(cwd, "untracked.txt"), "utf8")).toBe("user untracked\n");
		expect(git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(originalStatus);
		expect(git(first.path, ["branch", "--show-current"])).toBe(first.branch);
		// The worktree has only its generated pointer file, never a copied main Git directory.
		expect(lstatSync(path.join(first.path, ".git")).isFile()).toBe(true);
	});

	it("snapshots dirty tracked and nonignored untracked bytes and retains worker results", async () => {
		const cwd = repository();
		writeFileSync(path.join(cwd, "shared.txt"), "dirty\n");
		writeFileSync(path.join(cwd, "untracked.txt"), "new\n");
		writeFileSync(path.join(cwd, "ignored.txt"), "not selected\n");
		unlinkSync(path.join(cwd, "nested", "design.txt"));
		const workspace = retainForTestCleanup(await prepareWorkspace({ cwd, role: "worker", mode: "snapshot" }));
		expect(readFileSync(path.join(workspace.path, "shared.txt"), "utf8")).toBe("dirty\n");
		expect(readFileSync(path.join(workspace.path, "untracked.txt"), "utf8")).toBe("new\n");
		expect(existsSync(path.join(workspace.path, "ignored.txt"))).toBe(false);
		expect(existsSync(path.join(workspace.path, "nested", "design.txt"))).toBe(false);
		expect(existsSync(path.join(workspace.path, ".git"))).toBe(false);
		writeFileSync(path.join(workspace.path, "result.txt"), "worker output");
		await workspace.cleanup();
		expect(readFileSync(path.join(workspace.path, "result.txt"), "utf8")).toBe("worker output");
		expect(existsSync(path.join(cwd, "result.txt"))).toBe(false);
	});

	it("roots default and explicit snapshots consistently at a repository subtree cwd", async () => {
		const root = repository();
		const cwd = path.join(root, "nested");
		writeFileSync(path.join(cwd, "design.txt"), "dirty design\n");
		for (const files of [undefined, ["./design.txt"]]) {
			const workspace = retainForTestCleanup(
				await prepareWorkspace({ cwd, role: "worker", mode: "snapshot", files }),
			);
			expect(workspace.repositoryRoot).toBe(root);
			expect(readdirSync(workspace.path)).toEqual(["design.txt"]);
			expect(readFileSync(path.join(workspace.path, "design.txt"), "utf8")).toBe("dirty design\n");
		}
	});

	it("preserves the requested subtree cwd in a HEAD worktree", async () => {
		const root = repository();
		const workspace = retainForTestCleanup(
			await prepareWorkspace({ cwd: path.join(root, "nested"), role: "worker", mode: "worktree" }),
		);
		expect(path.basename(workspace.path)).toBe("nested");
		expect(readFileSync(path.join(workspace.path, "design.txt"), "utf8")).toBe("design\n");
		expect(existsSync(path.join(workspace.path, ".git"))).toBe(false);
	});

	it("copies only explicitly selected reviewer files from non-Git directories and cleans staging", async () => {
		const cwd = directory();
		writeFileSync(path.join(cwd, "concept.txt"), "review this");
		writeFileSync(path.join(cwd, "private.txt"), "not this");
		const workspace = retainForTestCleanup(
			await prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: ["concept.txt"] }),
		);
		expect(workspace.repositoryRoot).toBe(cwd);
		expect(readdirSync(workspace.path)).toEqual(["concept.txt"]);
		expect(readFileSync(path.join(workspace.path, "concept.txt"), "utf8")).toBe("review this");
		await workspace.cleanup();
		await workspace.cleanup();
		expect(existsSync(workspace.path)).toBe(false);
		expect(readFileSync(path.join(cwd, "private.txt"), "utf8")).toBe("not this");
	});

	it("allows an explicit empty reviewer workspace but rejects an omitted selection and worktree mode", async () => {
		const cwd = directory();
		const workspace = retainForTestCleanup(
			await prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: [] }),
		);
		expect(readdirSync(workspace.path)).toEqual([]);
		await expect(prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot" })).rejects.toThrow(/explicit files/);
		await expect(prepareWorkspace({ cwd, role: "reviewer", mode: "worktree", files: [] })).rejects.toThrow(
			/snapshot mode/,
		);
	});

	it.each([
		"../outside.txt",
		"nested/../../outside.txt",
		"..\\outside.txt",
		"/etc/passwd",
		"C:\\Windows\\win.ini",
		"C:secret",
		"\\\\server\\share\\secret",
		".git/config",
		"nested/.GiT/config",
		".git./config",
		"file.txt:stream",
	])("denies unsafe explicit selection %s before creating staging", async (file) => {
		await expect(
			prepareWorkspace({ cwd: directory(), role: "reviewer", mode: "snapshot", files: [file] }),
		).rejects.toThrow(/relative|Unsafe/);
	});

	it("rejects metadata cwd, directories, and explicit missing files", async () => {
		const cwd = repository();
		await expect(
			prepareWorkspace({ cwd: path.join(cwd, ".git"), role: "reviewer", mode: "snapshot", files: [] }),
		).rejects.toThrow(/metadata/);
		await expect(prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: ["nested"] })).rejects.toThrow(
			/regular files/,
		);
		await expect(
			prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: ["missing.txt"] }),
		).rejects.toThrow(/ENOENT/);
	});

	it("denies symlink and junction traversal, including a linked cwd", async () => {
		const cwd = repository();
		const outside = directory();
		writeFileSync(path.join(outside, "secret.txt"), "private");
		// Directory junctions do not require Windows symlink privileges.
		symlinkSync(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		await expect(
			prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: ["linked/secret.txt"] }),
		).rejects.toThrow(/symlink/);
		await expect(
			prepareWorkspace({ cwd: path.join(cwd, "linked"), role: "reviewer", mode: "snapshot", files: [] }),
		).rejects.toThrow(/symlink/);
		await expect(prepareWorkspace({ cwd, role: "worker", mode: "snapshot" })).rejects.toThrow(/symlink/);
	});

	it("rejects file symlinks from explicit and default selections", async (context) => {
		const cwd = repository();
		try {
			symlinkSync(path.join(cwd, "shared.txt"), path.join(cwd, "alias.txt"), "file");
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				context.skip();
				return;
			}
			throw error;
		}
		await expect(prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: ["alias.txt"] })).rejects.toThrow(
			/symlink/,
		);
		await expect(prepareWorkspace({ cwd, role: "worker", mode: "snapshot" })).rejects.toThrow(/symlink/);
	});

	it("bounds explicit snapshot file count and individual file bytes", async () => {
		const cwd = directory();
		await expect(
			prepareWorkspace({
				cwd,
				role: "reviewer",
				mode: "snapshot",
				files: Array.from({ length: 10_001 }, (_, index) => `file-${index}.txt`),
			}),
		).rejects.toThrow(/10000 files/);
		const large = path.join(cwd, "large.bin");
		writeFileSync(large, "");
		truncateSync(large, 16 * 1024 * 1024 + 1);
		await expect(prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: ["large.bin"] })).rejects.toThrow(
			/exceeds .* bytes/,
		);
	});

	it("bounds aggregate snapshot bytes before creating staging", async () => {
		const cwd = directory();
		const files = Array.from({ length: 7 }, (_, index) => `large-${index}.bin`);
		for (const file of files) {
			writeFileSync(path.join(cwd, file), "");
			truncateSync(path.join(cwd, file), 16 * 1024 * 1024);
		}
		await expect(prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files })).rejects.toThrow(/total bytes/);
	});

	it("rejects worktree file selections and requires Git for worker defaults", async () => {
		const cwd = directory();
		await expect(prepareWorkspace({ cwd, role: "worker", mode: "worktree", files: [] })).rejects.toThrow(
			/starts from HEAD/,
		);
		await expect(prepareWorkspace({ cwd, role: "worker", mode: "worktree" })).rejects.toThrow(/requires a Git/);
		await expect(prepareWorkspace({ cwd, role: "worker", mode: "snapshot" })).rejects.toThrow(/requires a Git/);
	});

	it("rolls back registered worktrees and branches when a subtree is absent at HEAD", async () => {
		const cwd = repository();
		const newSubtree = path.join(cwd, "untracked-directory");
		mkdirSync(newSubtree);
		writeFileSync(path.join(newSubtree, "user.txt"), "retain");
		const branches = git(cwd, ["branch", "--list"]);
		const worktrees = git(cwd, ["worktree", "list", "--porcelain"]);
		await expect(prepareWorkspace({ cwd: newSubtree, role: "worker", mode: "worktree" })).rejects.toThrow(
			/ENOENT|does not exist at HEAD/,
		);
		expect(git(cwd, ["branch", "--list"])).toBe(branches);
		expect(git(cwd, ["worktree", "list", "--porcelain"])).toBe(worktrees);
		expect(readFileSync(path.join(newSubtree, "user.txt"), "utf8")).toBe("retain");
	});

	it("rejects symlinks stored in HEAD before creating a worktree", async () => {
		const cwd = repository();
		const object = git(cwd, ["hash-object", "-w", "--stdin"], "../../outside.txt");
		git(cwd, ["update-index", "--add", "--cacheinfo", `120000,${object},linked.txt`]);
		git(cwd, ["-c", "core.hooksPath=", "commit", "-m", "Symlink fixture"]);
		const branches = git(cwd, ["branch", "--list"]);
		const worktrees = git(cwd, ["worktree", "list", "--porcelain"]);
		await expect(prepareWorkspace({ cwd, role: "worker", mode: "worktree" })).rejects.toThrow(/symlinks/);
		expect(git(cwd, ["branch", "--list"])).toBe(branches);
		expect(git(cwd, ["worktree", "list", "--porcelain"])).toBe(worktrees);
	});

	it("rolls back a worktree and branch when canceled during Git registration", async () => {
		const cwd = repository();
		const metadata = path.join(cwd, ".git", "worktrees");
		mkdirSync(metadata, { recursive: true });
		const branches = git(cwd, ["branch", "--list"]);
		const worktrees = git(cwd, ["worktree", "list", "--porcelain"]);
		const controller = new AbortController();
		const watcher = watch(metadata, () => controller.abort());
		try {
			await expect(
				prepareWorkspace({ cwd, role: "worker", mode: "worktree", signal: controller.signal }),
			).rejects.toThrow(/aborted/);
			expect(controller.signal.aborted).toBe(true);
		} finally {
			watcher.close();
		}
		expect(git(cwd, ["branch", "--list"])).toBe(branches);
		expect(git(cwd, ["worktree", "list", "--porcelain"])).toBe(worktrees);
	});

	it("pre-aborts every mode without filesystem or Git changes", async () => {
		const cwd = repository();
		const controller = new AbortController();
		controller.abort();
		const branches = git(cwd, ["branch", "--list"]);
		const worktrees = git(cwd, ["worktree", "list", "--porcelain"]);
		for (const mode of ["snapshot", "worktree"] as const) {
			await expect(prepareWorkspace({ cwd, role: "worker", mode, signal: controller.signal })).rejects.toThrow(
				/aborted/,
			);
		}
		await expect(
			prepareWorkspace({ cwd, role: "reviewer", mode: "snapshot", files: [], signal: controller.signal }),
		).rejects.toThrow(/aborted/);
		expect(git(cwd, ["branch", "--list"])).toBe(branches);
		expect(git(cwd, ["worktree", "list", "--porcelain"])).toBe(worktrees);
	});
});
