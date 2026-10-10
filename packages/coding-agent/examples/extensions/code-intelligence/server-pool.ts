import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { LanguageServer, type ServerConfig } from "./client.ts";

function parseConfig(text: string): ServerConfig[] {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || !("servers" in value) || !Array.isArray(value.servers)) {
		throw new Error("LSP configuration must contain a servers array");
	}
	return value.servers.map((entry: unknown) => {
		if (!entry || typeof entry !== "object") throw new Error("Invalid LSP server configuration");
		const server = entry as Record<string, unknown>;
		if (
			typeof server.command !== "string" ||
			!server.command.trim() ||
			typeof server.languageId !== "string" ||
			!server.languageId ||
			!Array.isArray(server.args) ||
			!server.args.every((arg: unknown) => typeof arg === "string") ||
			!Array.isArray(server.extensions) ||
			server.extensions.length === 0 ||
			!server.extensions.every((ext: unknown) => typeof ext === "string" && /^\.[a-z0-9]+$/i.test(ext))
		)
			throw new Error("Each LSP server needs command, args, languageId, and extensions (such as .ts)");
		return {
			command: server.command,
			args: server.args as string[],
			languageId: server.languageId,
			extensions: server.extensions as string[],
			initializationOptions: server.initializationOptions,
		};
	});
}

/** A reusable, explicitly configured workspace pool; clients retain their own query queues. */
export class ServerPool {
	private servers: { config: ServerConfig; client: LanguageServer }[] = [];
	private root: string | undefined;
	private configPath: string | undefined;
	private queue: Promise<void> = Promise.resolve();

	async get(path: string, cwd: string, configPath: string, signal?: AbortSignal): Promise<LanguageServer> {
		signal?.throwIfAborted();
		const root = resolve(cwd);
		const selectedConfig = resolve(root, configPath);
		const absolutePath = resolve(root, path);
		const client = await this.enqueue(async () => {
			signal?.throwIfAborted();
			if (this.configPath !== selectedConfig || this.root !== root) {
				await this.clear();
				const configs = parseConfig(await readFile(selectedConfig, { encoding: "utf8", signal }));
				signal?.throwIfAborted();
				this.servers = configs.map((config) => ({ config, client: new LanguageServer(config, root) }));
				this.root = root;
				this.configPath = selectedConfig;
			}
			const server = this.servers.find(({ config }) => config.extensions.includes(extname(absolutePath)));
			if (!server) {
				throw new Error(
					`No configured language server for ${extname(absolutePath) || absolutePath}; use source search instead`,
				);
			}
			return server.client;
		});
		await client.start(signal);
		return client;
	}

	async stop(): Promise<void> {
		await this.enqueue(() => this.clear());
	}

	private async clear(): Promise<void> {
		const previous = this.servers;
		this.servers = [];
		this.root = undefined;
		this.configPath = undefined;
		await Promise.all(previous.map(({ client }) => client.stop()));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}
