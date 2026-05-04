import {
  EventType,
  type AGUIEvent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/core";
import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { z } from "zod";

import { env } from "@/src/env.mjs";

const ASSISTANT_TITLE = "Langfuse Assistant";
const ASSISTANT_SYSTEM_PROMPT = [
  "You are the persistent in-app assistant for Langfuse.",
  "Be concise, factual, and useful.",
  "If you are not confident in the answer, say that directly instead of guessing.",
  "Use markdown when it improves clarity.",
].join(" ");

export const agentStateSchema = z.looseObject({
  claudeSessionId: z.string().optional(),
});

export type AgentState = z.infer<typeof agentStateSchema>;

const forwardedPropsSchema = z.record(z.string(), z.unknown());

const claudeSessionStateSchema = z.object({
  session_id: z.string().optional(),
  sessionId: z.string().optional(),
});

export const __internal = {
  buildAdapterInput,
  normalizeAdapterEvent,
  readClaudeSessionId,
};

export function createAgUiStream(params: {
  input: RunAgentInput;
  state: AgentState;
  signal: AbortSignal;
}) {
  const encoder = new TextEncoder();

  const adapter = new ClaudeAgentAdapter({
    permissionMode: "dontAsk",
    title: ASSISTANT_TITLE,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    env: getClaudeSdkEnv(),
    includePartialMessages: true,

    // Use cheap settings for testing
    model: "haiku",
    effort: "low",
  });

  const adapterInput = buildAdapterInput(params.input, params.state);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const closeController = () => {
        if (closed) {
          return;
        }

        closed = true;
        controller.close();
      };

      const abort = () => {
        void adapter.interrupt().catch(() => undefined);
        closeController();
      };

      const subscription = adapter.run(adapterInput).subscribe({
        next(event) {
          if (closed || params.signal.aborted) {
            abort();
            return;
          }

          for (const agUiEvent of normalizeAdapterEvent(event)) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(agUiEvent)}\n\n`),
            );
          }
        },
        error(error) {
          const message =
            error instanceof Error ? error.message : "Unknown assistant error";

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: EventType.RUN_ERROR,
                message,
              } satisfies AGUIEvent)}\n\n`,
            ),
          );
          closeController();
        },
        complete() {
          closeController();
        },
      });

      params.signal.addEventListener(
        "abort",
        () => {
          subscription.unsubscribe();
          abort();
        },
        { once: true },
      );
    },
  });
}

function buildAdapterInput(
  input: RunAgentInput,
  state: AgentState,
): RunAgentInput {
  if (!state.claudeSessionId) {
    return input;
  }

  return {
    ...input,
    forwardedProps: {
      ...(forwardedPropsSchema.safeParse(input.forwardedProps).data ?? {}),
      resume: state.claudeSessionId,
    },
  };
}

function normalizeAdapterEvent(event: BaseEvent): AGUIEvent[] {
  if (event.type === EventType.CUSTOM && event.name === "system:init") {
    const sessionId = readClaudeSessionId(event.value);

    return sessionId
      ? [
          {
            type: EventType.STATE_DELTA,
            delta: [
              {
                op: "add",
                path: "/claudeSessionId",
                value: sessionId,
              },
            ],
          },
        ]
      : [];
  }

  return [event as AGUIEvent];
}

function readClaudeSessionId(value: unknown): string | undefined {
  const parsedValue = claudeSessionStateSchema.safeParse(value);

  return parsedValue.success
    ? (parsedValue.data.session_id ?? parsedValue.data.sessionId)
    : undefined;
}

function getClaudeSdkEnv() {
  return {
    ...(env.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
      : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP: "langfuse-assistant",
  };
}
