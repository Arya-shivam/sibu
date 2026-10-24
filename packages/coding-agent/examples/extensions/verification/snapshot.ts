import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { normalize, resolve } from "node:path";

export const MAX_FILES = 256;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ManifestEntry {
	path: string;
	hash: string;
	bytes: number;
}

export interface InputSnapshot {
	manifest: ManifestEntry[];
	manifestHash: string;
}

export function hashBytes(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function canonicalPath(path: string): Promise<string> {
	const normalized = normalize(await realpath(path));
	return process.platform === "win32" ? normalized.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : normalized;
}

/** Resolve every input afresh and hash raw bytes; metadata never substitutes for reading. */
export async function snapshotInputs(
	files: readonly string[],
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<InputSnapshot> {
	if (files.length === 0) throw new Error("Verification requires a nonempty explicit files scope.");
	if (files.length > MAX_FILES) throw new Error("Verification scope exceeds the 256-file limit.");
	const paths = new Set<string>();
	for (const file of files) {
		signal?.throwIfAborted();
		if (!file || file.includes("\0")) throw new Error("Verification files must be nonempty literal file paths.");
		paths.add(await canonicalPath(resolve(workspaceRoot, file)));
	}
	const manifest: ManifestEntry[] = [];
	let totalBytes = 0;
	const buffer = Buffer.allocUnsafe(64 * 1024);
	for (const path of [...paths].sort()) {
		signal?.throwIfAborted();
		// Reject directories/devices/FIFOs before opening, then check the actual handle too.
		if (!(await stat(path)).isFile()) throw new Error(`Verification input must be a regular file: ${path}`);
		const file = await open(path, "r");
		try {
			const metadata = await file.stat();
			if (!metadata.isFile()) throw new Error(`Verification input must be a regular file: ${path}`);
			if (metadata.size > MAX_FILE_BYTES) throw new Error(`Verification input exceeds the 8 MiB limit: ${path}`);
			if (totalBytes + metadata.size > MAX_TOTAL_BYTES)
				throw new Error("Verification inputs exceed the 64 MiB total limit.");
			const hash = createHash("sha256");
			let bytes = 0;
			while (true) {
				signal?.throwIfAborted();
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				bytes += bytesRead;
				if (bytes > MAX_FILE_BYTES) throw new Error(`Verification input exceeds the 8 MiB limit: ${path}`);
				if (totalBytes + bytes > MAX_TOTAL_BYTES)
					throw new Error("Verification inputs exceed the 64 MiB total limit.");
				hash.update(buffer.subarray(0, bytesRead));
			}
			totalBytes += bytes;
			manifest.push({ path, hash: hash.digest("hex"), bytes });
		} finally {
			await file.close();
		}
	}
	signal?.throwIfAborted();
	return { manifest, manifestHash: hashBytes(JSON.stringify(manifest)) };
}
