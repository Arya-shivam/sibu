import { EventEmitter, once } from "node:events";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { disposeExtensionCleanups } from "../src/core/extensions/cleanup.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionResult, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let directory: string;
let active: CreateAgentSessionResult | undefined;
const servers: Server[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-cleanup-"));
});
afterEach(async () => {
	if (active) {
		await emitSessionShutdownEvent(active.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		active.session.dispose();
		active = undefined;
	}
	for (const server of servers.splice(0)) {
		if (server.listening) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.close((error) => (error ? reject(error) : resolve()));
			await promise;
		}
	}
	await rm(directory, { recursive: true, force: true });
});

async function start(factory: (pi: ExtensionAPI) => void) {
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
		extensionFactories: [factory],
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
		resourceLoader: loader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(directory),
	});
	const startupErrors: unknown[] = [];
	await active.session.bindExtensions({ onError: (error) => startupErrors.push(error) });
	expect(startupErrors).toEqual([]);
	return active.session;
}

describe("owned extension resources", () => {
	test("reload releases a real listening socket before replacement startup", async () => {
		let port = 0;
		let listening: Server | undefined;
		const order: string[] = [];
		const session = await start((pi) => {
			pi.on("session_start", async () => {
				const server = createServer();
				servers.push(server);
				pi.registerCleanup(async () => {
					if (server.listening) {
						const { promise, resolve, reject } = Promise.withResolvers<void>();
						server.close((error) => (error ? reject(error) : resolve()));
						await promise;
					}
					order.push("closed");
				});
				server.listen(port, "127.0.0.1");
				await once(server, "listening");
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Missing TCP address");
				port = address.port;
				listening = server;
				order.push("started");
			});
		});
		for (let index = 0; index < 3; index++) {
			const previous = listening;
			await session.reload();
			expect(previous?.listening).toBe(false);
			expect(listening?.listening).toBe(true);
		}
		expect(order).toEqual(["started", "closed", "started", "closed", "started", "closed", "started"]);
	});

	test("manual disposal and overlapping shutdown await one reverse-order cleanup", async () => {
		const order: string[] = [];
		let disposeFirst: (() => Promise<void>) | undefined;
		let shutdowns = 0;
		const session = await start((pi) => {
			disposeFirst = pi.registerCleanup(async () => {
				order.push("first");
			});
			pi.registerCleanup(async () => {
				order.push("second");
			});
			pi.on("session_shutdown", () => {
				shutdowns++;
			});
		});
		await Promise.all([disposeFirst!(), disposeFirst!()]);
		await Promise.all([
			emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" }),
			emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" }),
		]);
		expect(order).toEqual(["first", "second"]);
		expect(shutdowns).toBe(1);
	});

	test("cleanup failures do not skip remaining resources and retain extension provenance", async () => {
		const order: string[] = [];
		const session = await start((pi) => {
			pi.registerCleanup(() => {
				order.push("first");
			});
			pi.registerCleanup(() => {
				throw new Error("close failed");
			});
			pi.registerCleanup(() => {
				order.push("last");
			});
		});
		const errors: { event: string; extensionPath: string; error: string }[] = [];
		session.extensionRunner.onError((error) => errors.push(error));
		await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		expect(order).toEqual(["last", "first"]);
		expect(errors).toEqual([
			expect.objectContaining({
				event: "cleanup",
				extensionPath: "<inline:1>",
				error: expect.stringContaining("close failed"),
			}),
		]);
	});

	test("factory failure awaits owned file cleanup and leaves successful siblings alive", async () => {
		const runtime = createExtensionRuntime();
		const bus = createEventBus();
		const successful = await open(join(directory, "successful.txt"), "w+");
		await loadExtensionFromFactory(
			(pi) => {
				pi.registerCleanup(() => successful.close());
			},
			directory,
			bus,
			runtime,
			"successful",
		);
		const failed = await open(join(directory, "failed.txt"), "w+");
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.registerCleanup(() => failed.close());
					throw new Error("initialization failed");
				},
				directory,
				bus,
				runtime,
				"failed",
			),
		).rejects.toThrow("initialization failed");
		await expect(failed.stat()).rejects.toThrow();
		await expect(successful.writeFile("still owned")).resolves.toBeUndefined();
		runtime.invalidate();
		// Runtime invalidation initiates cleanup; no unawaited native handles survive this test.
		await disposeExtensionCleanups(runtime);
		await expect(successful.stat()).rejects.toThrow();
	});

	test("async cleanup finishes before an earlier resource is disposed", async () => {
		const order: string[] = [];
		const session = await start((pi) => {
			pi.registerCleanup(() => {
				order.push("parent");
			});
			pi.registerCleanup(async () => {
				order.push("child:start");
				await Promise.resolve();
				order.push("child:closed");
			});
		});
		await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		expect(order).toEqual(["child:start", "child:closed", "parent"]);
	});

	test("direct synchronous session disposal initiates awaitable resource cleanup", async () => {
		const handle = await open(join(directory, "owned.txt"), "w+");
		const session = await start((pi) => {
			pi.registerCleanup(() => handle.close());
		});
		session.dispose();
		await session.extensionRunner.dispose();
		await expect(handle.stat()).rejects.toThrow();
	});

	test("reload removes owned external listeners instead of delivering duplicate events", async () => {
		const emitter = new EventEmitter();
		const deliveries: string[] = [];
		const session = await start((pi) => {
			pi.on("session_start", () => {
				const handler = (message: string) => {
					deliveries.push(message);
				};
				emitter.on("message", handler);
				pi.registerCleanup(() => {
					emitter.off("message", handler);
				});
			});
		});
		emitter.emit("message", "initial");
		await session.reload();
		emitter.emit("message", "replacement");
		await session.reload();
		emitter.emit("message", "latest");
		await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		emitter.emit("message", "must not deliver");
		expect(deliveries).toEqual(["initial", "replacement", "latest"]);
	});

	test("registering cleanup after shutdown is rejected", async () => {
		let pi: ExtensionAPI | undefined;
		const session = await start((api) => {
			pi = api;
		});
		await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		expect(() => pi!.registerCleanup(() => {})).toThrow();
	});
});
