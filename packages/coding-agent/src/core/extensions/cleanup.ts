import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionRuntime } from "./types.ts";

export interface CleanupFailure {
	extensionPath: string;
	error: unknown;
}

type CleanupCallback = () => void | Promise<void>;

interface RuntimeCleanup {
	runtime: ExtensionRuntime;
	entries: Set<CleanupEntry>;
	started: boolean;
	promise?: Promise<CleanupFailure[]>;
}

interface CleanupScope {
	extensionPath: string;
	entries: Set<CleanupEntry>;
	closed: boolean;
	promise?: Promise<CleanupFailure[]>;
}

interface CleanupEntry {
	runtime: RuntimeCleanup;
	scope: CleanupScope;
	callback?: CleanupCallback;
	promise?: Promise<void>;
	outcome?: Promise<CleanupFailure | undefined>;
	settled: boolean;
}

interface CleanupContext {
	entry: CleanupEntry;
	parent?: CleanupContext;
}

const runtimes = new WeakMap<ExtensionRuntime, RuntimeCleanup>();
const cleanupContext = new AsyncLocalStorage<CleanupContext>();

function getRuntimeCleanup(runtime: ExtensionRuntime): RuntimeCleanup {
	let cleanup = runtimes.get(runtime);
	if (!cleanup) {
		cleanup = { runtime, entries: new Set(), started: false };
		runtimes.set(runtime, cleanup);
	}
	return cleanup;
}

function findRunningCleanup(predicate: (entry: CleanupEntry) => boolean): CleanupEntry | undefined {
	for (let context = cleanupContext.getStore(); context; context = context.parent) {
		if (!context.entry.settled && predicate(context.entry)) return context.entry;
	}
	return undefined;
}

/** Used by shutdown orchestration to reject cleanup callbacks awaiting their own shutdown. */
export function isExtensionCleanupRunning(runtime: ExtensionRuntime): boolean {
	return findRunningCleanup((entry) => entry.runtime.runtime === runtime) !== undefined;
}

function reentryFailure(entry: CleanupEntry): CleanupFailure {
	return {
		extensionPath: entry.scope.extensionPath,
		error: new Error(`Extension "${entry.scope.extensionPath}" cleanup cannot await its own cleanup drain.`),
	};
}

function startCleanup(entry: CleanupEntry): Promise<void> {
	if (entry.promise) {
		if (findRunningCleanup((running) => running === entry)) {
			return Promise.reject(reentryFailure(entry).error);
		}
		return entry.promise;
	}

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	entry.promise = promise;
	// Attach the failure observer before invoking user code, including synchronous throws.
	entry.outcome = promise.then(
		() => {
			finishCleanup(entry);
			return undefined;
		},
		(error: unknown) => {
			finishCleanup(entry);
			return { extensionPath: entry.scope.extensionPath, error };
		},
	);
	const callback = entry.callback;
	entry.callback = undefined;
	try {
		const result = cleanupContext.run({ entry, parent: cleanupContext.getStore() }, () => callback?.());
		Promise.resolve(result).then(resolve, reject);
	} catch (error) {
		reject(error);
	}
	return promise;
}

function finishCleanup(entry: CleanupEntry): void {
	entry.settled = true;
	entry.scope.entries.delete(entry);
	entry.runtime.entries.delete(entry);
}

async function drainCleanups(entries: CleanupEntry[]): Promise<CleanupFailure[]> {
	const failures: CleanupFailure[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		startCleanup(entry);
		const failure = await entry.outcome;
		if (failure) failures.push(failure);
	}
	return failures;
}

/** Create one extension-owned cleanup scope without adding fields to the shared runtime. */
export function createExtensionCleanup(runtime: ExtensionRuntime, extensionPath: string) {
	const runtimeCleanup = getRuntimeCleanup(runtime);
	runtime.assertActive();
	if (runtimeCleanup.started) throw new Error(`Extension "${extensionPath}" cleanup has already started.`);
	const scope: CleanupScope = { extensionPath, entries: new Set(), closed: false };

	return {
		register(callback: CleanupCallback): () => Promise<void> {
			runtime.assertActive();
			if (scope.closed || runtimeCleanup.started) {
				throw new Error(`Extension "${extensionPath}" cleanup has already started.`);
			}
			const entry: CleanupEntry = { runtime: runtimeCleanup, scope, callback, settled: false };
			scope.entries.add(entry);
			runtimeCleanup.entries.add(entry);
			return () => startCleanup(entry);
		},
		dispose(): Promise<CleanupFailure[]> {
			const running = findRunningCleanup((entry) => entry.scope === scope);
			if (running) return Promise.resolve([reentryFailure(running)]);
			if (scope.promise) return scope.promise;
			scope.closed = true;
			const entries = Array.from(scope.entries);
			// Publish the shared promise before invoking callbacks that may reenter disposal.
			scope.promise = Promise.resolve().then(() => drainCleanups(entries));
			return scope.promise;
		},
	};
}

/** Start teardown once, await all owned and already-running callbacks, and collect every failure. */
export function disposeExtensionCleanups(runtime: ExtensionRuntime): Promise<CleanupFailure[]> {
	const cleanup = getRuntimeCleanup(runtime);
	const running = findRunningCleanup((entry) => entry.runtime === cleanup);
	if (running) return Promise.resolve([reentryFailure(running)]);
	if (cleanup.promise) return cleanup.promise;
	cleanup.started = true;
	const entries = Array.from(cleanup.entries);
	cleanup.promise = Promise.resolve().then(() => drainCleanups(entries));
	return cleanup.promise;
}
