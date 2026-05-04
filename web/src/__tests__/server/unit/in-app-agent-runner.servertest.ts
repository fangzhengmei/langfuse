import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { interruptMock, runMock } = vi.hoisted(() => ({
  interruptMock: vi.fn().mockResolvedValue(undefined),
  runMock: vi.fn(),
}));

vi.mock("@ag-ui/claude-agent-sdk", () => ({
  ClaudeAgentAdapter: class {
    interrupt = interruptMock;
    run = runMock;
  },
}));

import {
  __internal,
  createAgUiStream,
} from "@/src/features/in-app-agent/server/agent";

describe("in-app-agent runner", () => {
  beforeEach(() => {
    interruptMock.mockClear();
    runMock.mockReset();
  });

  it("passes resume state through forwarded props for Claude session continuation", () => {
    const input = buildRunAgentInput();

    expect(
      __internal.buildAdapterInput(input, {
        claudeSessionId: "session-123",
      }),
    ).toMatchObject({
      forwardedProps: {
        resume: "session-123",
      },
    });
  });

  it("converts Claude system init events into AG-UI state deltas", () => {
    expect(
      __internal.normalizeAdapterEvent({
        type: EventType.CUSTOM,
        name: "system:init",
        value: {
          session_id: "session-123",
        },
      }),
    ).toEqual([
      {
        type: EventType.STATE_DELTA,
        delta: [
          {
            op: "add",
            path: "/claudeSessionId",
            value: "session-123",
          },
        ],
      },
    ]);
  });

  it("streams adapter events as SSE while hiding raw Claude init events", async () => {
    runMock.mockImplementation(() => ({
      subscribe(handlers: {
        next: (event: AGUIEvent) => void;
        complete: () => void;
      }) {
        handlers.next({
          type: EventType.RUN_STARTED,
          threadId: "thread-1",
          runId: "run-1",
        });
        handlers.next({
          type: EventType.CUSTOM,
          name: "system:init",
          value: {
            session_id: "session-123",
          },
        });
        handlers.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "message-1",
          role: "assistant",
        });
        handlers.complete();

        return {
          unsubscribe() {},
        };
      },
    }));

    const stream = createAgUiStream({
      input: buildRunAgentInput(),
      state: {},
      signal: new AbortController().signal,
    });

    const events = await readSseEvents(stream);

    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        type: EventType.STATE_DELTA,
        delta: [
          {
            op: "add",
            path: "/claudeSessionId",
            value: "session-123",
          },
        ],
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-1",
        role: "assistant",
      },
    ]);
  });
});

function buildRunAgentInput(): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [],
  };
}

async function readSseEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<AGUIEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();

  return output
    .trim()
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, ""))
    .map((chunk) => JSON.parse(chunk) as AGUIEvent);
}
