import type { TurnActivityAttributes, TurnActivityState } from "../../../shared/phone-activity.ts";

export interface RelayPushMessage { id: string; kind: string; botId: string; botName: string; threadId: string; groupId?: string; requestId?: string; sealed?: string; badge?: number }
export interface RelayActivityPush {
  event: "update" | "end" | "start";
  state: Omit<TurnActivityState, "line">;
  timestamp: number;
  priority: 5 | 10;
  dismissAt?: number;
  attributes?: TurnActivityAttributes;
}

export function pushMessage(value: unknown): RelayPushMessage | null;
export function pushCategory(push: { kind: string; requestId?: string; groupId?: string }): string | undefined;
export function activityMessage(value: unknown): RelayActivityPush | null;
export function activityBody(push: RelayActivityPush): object;
export function alertBody(message: RelayPushMessage): object;
export function fcmBody(token: string, message: RelayPushMessage, draws: boolean): object;
export const SERVICE_TIMEOUT_MS: number;
export function createPushRelay(options?: Record<string, unknown>): { services: string[]; route(...args: unknown[]): Promise<unknown> };
