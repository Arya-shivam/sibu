import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "./sandbox.ts";

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new Error(`${name} must be a nonempty string`);
	return value;
}

/** Only trusted user configuration or an explicit CLI flag selects the execution backend. */
export function loadSandboxConfig(flag: string | boolean | undefined): SandboxConfig | undefined {
	const explicit = typeof flag === "string" && flag.length > 0;
	const configPath = explicit ? path.resolve(flag) : path.join(getAgentDir(), "subagent-sandbox.json");
	if (!explicit && !existsSync(configPath)) return undefined;
	const config = object(JSON.parse(readFileSync(configPath, "utf8")), "Sandbox configuration");
	const allowed: Record<string, true> = {
		executable: true,
		template: true,
		piCommand: true,
		cpus: true,
		memory: true,
		timeoutMs: true,
		networkAllow: true,
		egmRoot: true,
		codexProxy: true,
	};
	for (const key of Object.keys(config))
		if (!Object.hasOwn(allowed, key)) throw new Error(`Unknown sandbox configuration field: ${key}`);
	const executable = text(config.executable, "executable");
	if (!path.isAbsolute(executable)) throw new Error("Sandbox executable must be an absolute path");
	const template = text(config.template, "template");
	const piCommand = text(config.piCommand, "piCommand");
	if (!piCommand.startsWith("/")) throw new Error("piCommand must be an absolute guest path");
	const cpus = config.cpus ?? 2;
	if (typeof cpus !== "number" || !Number.isInteger(cpus) || cpus < 1 || cpus > 16)
		throw new Error("cpus must be an integer from 1 to 16");
	const memory = config.memory ?? "2g";
	if (typeof memory !== "string" || !/^[1-9]\d*[mg]$/i.test(memory))
		throw new Error("memory must be a positive size such as 2g or 512m");
	const timeoutMs = config.timeoutMs ?? 600000;
	if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
		throw new Error("timeoutMs must be an integer from 1000 to 3600000");
	const networkAllow = config.networkAllow ?? [];
	if (
		!Array.isArray(networkAllow) ||
		networkAllow.some(
			(host) => typeof host !== "string" || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?(?::\d{1,5})?$/i.test(host),
		)
	)
		throw new Error("networkAllow must list explicit hostnames, optionally with ports; wildcards are not allowed");
	let egmRoot: string | undefined;
	if (config.egmRoot !== undefined) {
		egmRoot = realpathSync(path.resolve(path.dirname(configPath), text(config.egmRoot, "egmRoot")));
		for (const directory of ["agents", "resources/document_standards"]) {
			if (!statSync(path.join(egmRoot, directory)).isDirectory())
				throw new Error(`EGM bundle is missing ${directory}`);
		}
	}
	let codexProxy: SandboxConfig["codexProxy"];
	if (config.codexProxy !== undefined) {
		const proxy = object(config.codexProxy, "codexProxy");
		for (const key of Object.keys(proxy))
			if (key !== "command" && key !== "accountId") throw new Error(`Unknown codexProxy field: ${key}`);
		const accountId = text(proxy.accountId, "codexProxy.accountId");
		if (!/^[a-z\d_-]+$/i.test(accountId)) throw new Error("codexProxy.accountId must be an account identifier");
		codexProxy = { command: text(proxy.command, "codexProxy.command"), accountId };
	}
	return {
		executable,
		template,
		piCommand,
		cpus,
		memory,
		timeoutMs,
		networkAllow: networkAllow as string[],
		egmRoot,
		codexProxy,
	};
}
