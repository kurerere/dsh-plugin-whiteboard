import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BoardStore } from './board-store.ts';
/**
 * Build the three board tool definitions, bound to the plugin context so they
 * can read the live projection.
 * @param store - the Host board store the tools mutate.
 * @returns one definition per board tool, in prompt order.
 */
export declare function createBoardTools(store: BoardStore, ready?: Promise<unknown>): ToolDefinition[];
