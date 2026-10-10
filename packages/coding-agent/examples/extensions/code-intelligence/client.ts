import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ServerConfig {
	command: string;
	args: string[];
	languageId: string;
	extensions: string[];
	initializationOptions?: unknown;
}

type Action = "definition" | "references" | "hover" | "symbols" | "diagnostics" | "rename_preview";
type Position = { line: number; character: number };
type RecordValue = Record<string, unknown>;
type RequestId = number | string;
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}
interface OpenDocument {
	path: string;
	text: string;
	version: number;
}
interface DiagnosticWaiter {
	uri: string;
	version: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;

function record(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function aborted(): Error {
	const error = new Error("Language server operation aborted");
	error.name = "AbortError";
	return error;
}

function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted) throw aborted();
}

function fileIdentity(uri: string): string {
	const path = fileURLToPath(uri);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Wait independently: cancelling one caller must not cancel shared initialization. */
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise<T>((resolvePromise, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(aborted());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Incremental byte framing, with bounded header/body storage even for fragmented stdout. */
class MessageReader {
	private readonly header = Buffer.alloc(MAX_HEADER_BYTES);
	private headerLength = 0;
	private body: Buffer | undefined;
	private bodyLength = 0;

	private readonly receive: (message: unknown) => void;

	constructor(receive: (message: unknown) => void) {
		this.receive = receive;
	}

	push(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length) {
			if (!this.body) {
				if (this.headerLength === MAX_HEADER_BYTES) throw new Error("LSP header exceeds size limit");
				this.header[this.headerLength++] = chunk[offset++];
				const length = this.headerLength;
				if (
					length < 4 ||
					this.header[length - 4] !== 13 ||
					this.header[length - 3] !== 10 ||
					this.header[length - 2] !== 13 ||
					this.header[length - 1] !== 10
				) {
					continue;
				}
				const headers = this.header
					.subarray(0, length - 4)
					.toString("ascii")
					.split("\r\n");
				let contentLength: number | undefined;
				for (const header of headers) {
					const separator = header.indexOf(":");
					if (separator < 1) throw new Error("Malformed LSP header");
					if (header.slice(0, separator).toLowerCase() !== "content-length") continue;
					const value = header.slice(separator + 1).trim();
					if (contentLength !== undefined || !/^\d+$/.test(value)) throw new Error("Invalid LSP Content-Length");
					contentLength = Number(value);
				}
				if (contentLength === undefined || contentLength < 1 || contentLength > MAX_MESSAGE_BYTES) {
					throw new Error("Missing or oversized LSP Content-Length");
				}
				this.body = Buffer.alloc(contentLength);
				this.bodyLength = 0;
				this.headerLength = 0;
			}
			const count = Math.min(this.body.length - this.bodyLength, chunk.length - offset);
			chunk.copy(this.body, this.bodyLength, offset, offset + count);
			this.bodyLength += count;
			offset += count;
			if (this.bodyLength === this.body.length) {
				const message: unknown = JSON.parse(this.body.toString("utf8"));
				this.body = undefined;
				this.bodyLength = 0;
				this.receive(message);
			}
		}
	}
}

/** One explicitly configured local server. No shells, installation, or automatic restarts. */
export class LanguageServer {
	private readonly config: ServerConfig;
	private readonly root: string;
	private readonly rootUri: string;
	private process: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private stopPromise: Promise<void> | undefined;
	private exitPromise: Promise<void> | undefined;
	private state: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed" = "idle";
	private failure: Error | undefined;
	private capabilities: RecordValue = {};
	private syncKind = 0;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly documents = new Map<string, OpenDocument>();
	private readonly diagnosticWaiters = new Set<DiagnosticWaiter>();
	private stderr = Buffer.alloc(0);
	private queryQueue: Promise<void> = Promise.resolve();

	constructor(config: ServerConfig, root: string) {
		this.config = config;
		this.root = resolve(root);
		this.rootUri = pathToFileURL(this.root).href;
	}

	async start(signal?: AbortSignal): Promise<void> {
		checkSignal(signal);
		if (this.state === "stopping" || this.state === "stopped") throw new Error("Language server has stopped");
		if (this.state === "failed") throw this.failure ?? new Error("Language server failed");
		this.startPromise ??= this.initialize();
		await withSignal(this.startPromise, signal);
	}

	async query(
		action: Action,
		path: string,
		position: Position | undefined,
		newName: string | undefined,
		signal?: AbortSignal,
	): Promise<unknown> {
		checkSignal(signal);
		const operation = this.queryQueue.then(async () => {
			checkSignal(signal);
			await this.start(signal);
			return this.performQuery(action, path, position, newName, signal);
		});
		this.queryQueue = operation.then(
			() => {},
			() => {},
		);
		return withSignal(operation, signal);
	}

	async stop(): Promise<void> {
		this.stopPromise ??= this.shutdown();
		await this.stopPromise;
	}

	private async initialize(): Promise<void> {
		this.state = "starting";
		try {
			const child = spawn(this.config.command, this.config.args, {
				cwd: this.root,
				shell: false,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.process = child;
			this.exitPromise = new Promise<void>((resolveExit) => {
				child.once("exit", (code, signal) => {
					resolveExit();
					if (this.state !== "stopping" && this.state !== "stopped") {
						this.fail(new Error(`Language server exited (${signal ?? code ?? "unknown"})${this.stderrSuffix()}`));
					} else {
						this.rejectOutstanding(new Error("Language server stopped"));
					}
				});
				child.once("error", (error) => {
					resolveExit();
					this.fail(error);
				});
			});
			const reader = new MessageReader((message) => this.receive(message));
			child.stdout.on("data", (chunk: Buffer) => {
				try {
					reader.push(chunk);
				} catch (error) {
					this.fail(asError(error));
				}
			});
			child.stdout.on("error", (error) => this.fail(error));
			child.stdout.on("end", () => {
				if (this.state === "starting" || this.state === "running") {
					this.fail(new Error(`Language server closed stdout${this.stderrSuffix()}`));
				}
			});
			child.stdin.on("error", (error) => this.fail(error));
			child.stderr.on("error", (error) => this.fail(error));
			child.stderr.on("data", (chunk: Buffer) => {
				this.stderr = Buffer.concat([this.stderr, chunk.subarray(-MAX_STDERR_BYTES)]).subarray(-MAX_STDERR_BYTES);
			});
			const result = await this.request(
				"initialize",
				{
					processId: process.pid,
					clientInfo: { name: "pi-code-intelligence" },
					rootUri: this.rootUri,
					workspaceFolders: this.workspaceFolders(),
					initializationOptions: this.config.initializationOptions,
					capabilities: {
						general: { positionEncodings: ["utf-16"] },
						workspace: { applyEdit: false, configuration: true, workspaceFolders: true },
						textDocument: {
							synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
							definition: { dynamicRegistration: false, linkSupport: true },
							references: { dynamicRegistration: false },
							hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
							documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
							rename: { dynamicRegistration: false, prepareSupport: false },
							publishDiagnostics: { versionSupport: true },
							diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
						},
					},
				},
				undefined,
				START_TIMEOUT_MS,
			);
			if (!record(result) || !record(result.capabilities)) throw new Error("Invalid LSP initialize result");
			this.capabilities = result.capabilities;
			const encoding = this.capabilities.positionEncoding;
			if (encoding !== undefined && encoding !== "utf-16")
				throw new Error("Server does not support UTF-16 positions");
			const sync = this.capabilities.textDocumentSync;
			if (typeof sync === "number") this.syncKind = sync;
			else if (record(sync) && sync.openClose === true && typeof sync.change === "number")
				this.syncKind = sync.change;
			if (this.syncKind !== 1 && this.syncKind !== 2) {
				throw new Error("Server must support document open/close and full or incremental text synchronization");
			}
			if (this.state !== "starting") throw new Error("Language server stopped during initialization");
			this.notify("initialized", {});
			this.state = "running";
		} catch (error) {
			this.fail(asError(error));
			throw this.failure ?? asError(error);
		}
	}

	private async performQuery(
		action: Action,
		path: string,
		position: Position | undefined,
		newName: string | undefined,
		signal?: AbortSignal,
	): Promise<unknown> {
		const providers: Record<Action, string> = {
			definition: "definitionProvider",
			references: "referencesProvider",
			hover: "hoverProvider",
			symbols: "documentSymbolProvider",
			diagnostics: "diagnosticProvider",
			rename_preview: "renameProvider",
		};
		if (action !== "diagnostics" && !this.capabilities[providers[action]]) {
			throw new Error(`Server does not support ${action}`);
		}
		if (action !== "symbols" && action !== "diagnostics" && !position)
			throw new Error(`${action} requires a position`);
		if (action === "rename_preview" && !newName) throw new Error("rename_preview requires newName");
		const absolutePath = resolve(this.root, path);
		const uri = pathToFileURL(absolutePath).href;
		for (const [openUri, document] of this.documents) {
			checkSignal(signal);
			let text: string;
			try {
				text = await readFile(document.path, { encoding: "utf8", signal });
			} catch (error) {
				checkSignal(signal);
				this.ensureRunning();
				if (!record(error) || error.code !== "ENOENT") throw error;
				this.notify("textDocument/didClose", { textDocument: { uri: openUri } });
				this.documents.delete(openUri);
				continue;
			}
			checkSignal(signal);
			this.ensureRunning();
			if (text !== document.text) this.changeDocument(openUri, document, text);
		}
		let document = this.documents.get(uri);
		if (!document) {
			const text = await readFile(absolutePath, { encoding: "utf8", signal });
			checkSignal(signal);
			this.ensureRunning();
			document = { path: absolutePath, text, version: 1 };
			this.documents.set(uri, document);
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: this.config.languageId, version: document.version, text },
			});
		}
		if (action === "diagnostics") {
			if (this.capabilities.diagnosticProvider) {
				const provider = this.capabilities.diagnosticProvider;
				const result = await this.request(
					"textDocument/diagnostic",
					{
						textDocument: { uri },
						...(record(provider) && typeof provider.identifier === "string"
							? { identifier: provider.identifier }
							: {}),
					},
					signal,
				);
				if (!record(result) || result.kind !== "full" || !Array.isArray(result.items)) {
					throw new Error("Server did not return a full diagnostic report");
				}
				return result;
			}
			// A new version makes even an unchanged disk document require a fresh, correlated push.
			const diagnostics = this.waitForDiagnostics(uri, document.version + 1, signal);
			try {
				this.changeDocument(uri, document, document.text);
			} catch (error) {
				this.rejectDiagnostics(asError(error));
			}
			return diagnostics;
		}
		const methods: Record<Exclude<Action, "diagnostics">, string> = {
			definition: "textDocument/definition",
			references: "textDocument/references",
			hover: "textDocument/hover",
			symbols: "textDocument/documentSymbol",
			rename_preview: "textDocument/rename",
		};
		return this.request(
			methods[action],
			{
				textDocument: { uri },
				...(position ? { position } : {}),
				...(action === "references" ? { context: { includeDeclaration: true } } : {}),
				...(action === "rename_preview" ? { newName } : {}),
			},
			signal,
		);
	}

	private ensureRunning(): void {
		if (this.state !== "running") throw this.failure ?? new Error("Language server is not running");
	}

	private changeDocument(uri: string, document: OpenDocument, text: string): void {
		this.ensureRunning();
		const change: RecordValue = { text };
		if (this.syncKind === 2) {
			let line = 0;
			let lineStart = 0;
			for (let index = 0; index < document.text.length; index++) {
				const character = document.text.charCodeAt(index);
				if (character !== 10 && character !== 13) continue;
				if (character === 13 && document.text.charCodeAt(index + 1) === 10) index++;
				line++;
				lineStart = index + 1;
			}
			change.range = {
				start: { line: 0, character: 0 },
				end: { line, character: document.text.length - lineStart },
			};
		}
		document.version++;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: document.version },
			contentChanges: [change],
		});
		document.text = text;
	}

	private waitForDiagnostics(uri: string, version: number, signal?: AbortSignal): Promise<unknown> {
		checkSignal(signal);
		return new Promise((resolvePromise, reject) => {
			const onAbort = () => finish(aborted());
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							"No fresh version-correlated diagnostics received; server needs pull diagnostics or versioned pushes",
						),
					),
				REQUEST_TIMEOUT_MS,
			);
			const waiter: DiagnosticWaiter = {
				uri,
				version,
				resolve: resolvePromise,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					this.diagnosticWaiters.delete(waiter);
				},
			};
			const finish = (error: Error) => {
				waiter.cleanup();
				reject(error);
			};
			this.diagnosticWaiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private request(
		method: string,
		params: unknown,
		signal?: AbortSignal,
		timeout = REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		checkSignal(signal);
		if (this.state === "stopping" && method !== "shutdown") throw new Error("Language server is stopping");
		const id = this.nextId++;
		return new Promise((resolvePromise, reject) => {
			const cancel = (error: Error) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				pending.cleanup();
				try {
					this.notify("$/cancelRequest", { id });
				} catch {
					// The transport may already be gone; the original cancellation remains the result.
				}
				reject(error);
			};
			const onAbort = () => cancel(aborted());
			const timer = setTimeout(
				() => cancel(new Error(`LSP request timed out: ${method}${this.stderrSuffix()}`)),
				timeout,
			);
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
			};
			this.pending.set(id, { resolve: resolvePromise, reject, cleanup });
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				cleanup();
				reject(asError(error));
			}
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(message: RecordValue): void {
		const child = this.process;
		if (
			!child ||
			child.stdin.destroyed ||
			child.exitCode !== null ||
			child.signalCode !== null ||
			this.state === "failed" ||
			this.state === "stopped"
		) {
			throw this.failure ?? new Error("Language server transport is closed");
		}
		const body = Buffer.from(JSON.stringify(message), "utf8");
		if (body.length > MAX_MESSAGE_BYTES) {
			const error = new Error("LSP message exceeds size limit");
			this.fail(error);
			throw error;
		}
		if (child.stdin.writableLength > MAX_MESSAGE_BYTES * 2) {
			const error = new Error("Language server input queue exceeds size limit");
			this.fail(error);
			throw error;
		}
		child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		child.stdin.write(body);
	}

	private receive(message: unknown): void {
		if (!record(message) || message.jsonrpc !== "2.0")
			throw new Error("Invalid JSON-RPC message from language server");
		if (typeof message.method === "string") {
			if (typeof message.id === "number" || typeof message.id === "string") {
				this.serverRequest(message.id, message.method, message.params);
			} else if (message.method === "textDocument/publishDiagnostics" && record(message.params)) {
				const params = message.params;
				if (!Array.isArray(params.diagnostics) || typeof params.uri !== "string") return;
				for (const waiter of this.diagnosticWaiters) {
					if (fileIdentity(waiter.uri) === fileIdentity(params.uri) && waiter.version === params.version) {
						waiter.cleanup();
						waiter.resolve({ kind: "full", items: params.diagnostics });
					}
				}
			}
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		pending.cleanup();
		if (record(message.error)) {
			pending.reject(new Error(`LSP error ${String(message.error.code)}: ${String(message.error.message)}`));
		} else if ("result" in message) {
			pending.resolve(message.result);
		} else {
			pending.reject(new Error("Invalid JSON-RPC response"));
		}
	}

	private serverRequest(id: RequestId, method: string, params: unknown): void {
		if (method === "workspace/configuration") {
			if (!record(params) || !Array.isArray(params.items)) {
				this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Expected configuration items" } });
			} else {
				this.send({ jsonrpc: "2.0", id, result: params.items.map(() => null) });
			}
		} else if (method === "workspace/workspaceFolders") {
			this.send({ jsonrpc: "2.0", id, result: this.workspaceFolders() });
		} else if (method === "workspace/applyEdit") {
			this.send({
				jsonrpc: "2.0",
				id,
				result: { applied: false, failureReason: "Code intelligence is read-only; edits are preview-only" },
			});
		} else {
			this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
		}
	}

	private workspaceFolders(): { uri: string; name: string }[] {
		return [{ uri: this.rootUri, name: basename(this.root) || this.root }];
	}

	private stderrSuffix(): string {
		const text = this.stderr.toString("utf8").trim();
		return text ? `\nServer stderr (last ${MAX_STDERR_BYTES} bytes):\n${text}` : "";
	}

	private rejectDiagnostics(error: Error): void {
		for (const waiter of this.diagnosticWaiters) {
			waiter.cleanup();
			waiter.reject(error);
		}
	}

	private rejectOutstanding(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.rejectDiagnostics(error);
	}

	private fail(error: Error): void {
		this.failure ??= error;
		if (this.state !== "stopping" && this.state !== "stopped") this.state = "failed";
		this.rejectOutstanding(this.failure);
		this.documents.clear();
		const child = this.process;
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}

	private async shutdown(): Promise<void> {
		if (this.state === "stopped") return;
		const wasRunning = this.state === "running";
		this.state = "stopping";
		this.rejectOutstanding(new Error("Language server stopping"));
		const child = this.process;
		try {
			if (child && child.exitCode === null && child.signalCode === null) {
				if (wasRunning) {
					try {
						for (const uri of this.documents.keys())
							this.notify("textDocument/didClose", { textDocument: { uri } });
						await this.request("shutdown", null, undefined, STOP_TIMEOUT_MS);
						this.notify("exit", undefined);
						child.stdin.end();
					} catch {
						// Unresponsive servers are forcibly terminated below.
					}
				}
				if (!(await this.waitForExit(STOP_TIMEOUT_MS))) {
					child.kill("SIGTERM");
					if (!(await this.waitForExit(500))) {
						child.kill("SIGKILL");
						await this.waitForExit(500);
					}
				}
			}
		} finally {
			this.state = "stopped";
			this.rejectOutstanding(new Error("Language server stopped"));
			this.documents.clear();
			child?.stdin.destroy();
			child?.stdout.destroy();
			child?.stderr.destroy();
		}
	}

	private async waitForExit(timeout: number): Promise<boolean> {
		if (!this.exitPromise) return true;
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.exitPromise.then(() => true),
				new Promise<false>((resolveTimeout) => {
					timer = setTimeout(() => resolveTimeout(false), timeout);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}
