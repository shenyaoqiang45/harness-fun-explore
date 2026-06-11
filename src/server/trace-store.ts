import { randomUUID } from "node:crypto";
import type { TraceEvent, TraceEventType } from "../shared/types.js";

export class TraceStore {
  private readonly bySession = new Map<string, TraceEvent[]>();

  append(input: {
    sessionId: string;
    roundId: number;
    type: TraceEventType;
    summary: string;
    payload?: Record<string, unknown>;
    toolName?: string;
    status?: "ok" | "error";
    durationMs?: number;
  }): TraceEvent {
    const list = this.bySession.get(input.sessionId) ?? [];
    const event: TraceEvent = {
      id: randomUUID(),
      sessionId: input.sessionId,
      roundId: input.roundId,
      sequence: list.length + 1,
      type: input.type,
      summary: input.summary,
      payload: input.payload ?? {},
      toolName: input.toolName,
      status: input.status,
      durationMs: input.durationMs,
      timestamp: new Date().toISOString(),
    };

    list.push(event);
    this.bySession.set(input.sessionId, list);
    return event;
  }

  getTimeline(sessionId: string): TraceEvent[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  getEvent(sessionId: string, eventId: string): TraceEvent | undefined {
    return this.bySession.get(sessionId)?.find((event) => event.id === eventId);
  }
}
