/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers adapt tool execution and observe its raw result before tool_result transformations.
 * Tool call/result interception and final policy gating remain AgentSession agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const definition = registeredTool.definition;
	return wrapToolDefinition(
		{
			...definition,
			execute: (toolCallId, params, signal, onUpdate, ctx) =>
				runner.observeExecution(
					{
						kind: "tool",
						toolName: definition.name,
						toolCallId,
						input: params as Record<string, unknown>,
						cwd: ctx.cwd,
					},
					() => definition.execute(toolCallId, params, signal, onUpdate, ctx),
					signal,
					toolCallId,
				),
		},
		() => runner.createContext(),
	);
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
