import { RunAgentInputSchema } from "@ag-ui/core";

import { env } from "@/src/env.mjs";
import {
  agentStateSchema,
  createAgUiStream,
} from "@/src/features/in-app-agent/server/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "Assistant is not configured" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsedInput = RunAgentInputSchema.safeParse(body);

  if (!parsedInput.success) {
    return Response.json({ error: "Invalid AG-UI payload" }, { status: 400 });
  }

  const input = parsedInput.data;
  const parsedState = agentStateSchema.safeParse(input.state);

  if (!parsedState.success) {
    return Response.json({ error: "Invalid agent state" }, { status: 400 });
  }

  const stream = createAgUiStream({
    input,
    state: parsedState.data,
    signal: request.signal,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Content-Encoding": "none",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
