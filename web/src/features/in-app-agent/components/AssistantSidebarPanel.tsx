"use client";

import { type ReactNode } from "react";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessagePartText,
} from "@assistant-ui/react";
import { Bot, Loader2, PanelRightClose, SendHorizontal } from "lucide-react";
import { Streamdown } from "streamdown";
import { Button } from "@/src/components/ui/button";
import { cn } from "@/src/utils/tailwind";
import { useAssistantSidebar } from "@/src/features/in-app-agent/components/AssistantSidebarProvider";

export function AssistantSidebarPanel() {
  const { setOpen } = useAssistantSidebar();

  return (
    <section className="bg-background flex h-full min-w-0 flex-col border-l">
      <header className="bg-background flex h-11 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-muted text-foreground flex h-6 w-6 items-center justify-center rounded-xl">
            <Bot className="h-3 w-3" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Assistant</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(false)}
          aria-label="Close assistant sidebar"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </header>

      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
            <AuiIf condition={(state) => state.thread.isEmpty}>
              <div className="border-border rounded-2xl border border-dashed px-4 py-5">
                <p className="text-foreground text-sm font-medium">
                  Ask about Langfuse
                </p>
              </div>
            </AuiIf>

            <ol className="flex w-full flex-col gap-4">
              <ThreadPrimitive.Messages>
                {({ message }) => (
                  <li
                    key={message.id}
                    className={cn(
                      "w-fit max-w-[92%]",
                      message.role === "user" && "ml-auto",
                    )}
                  >
                    <AssistantSidebarMessage />
                  </li>
                )}
              </ThreadPrimitive.Messages>
            </ol>
          </div>
        </ThreadPrimitive.Viewport>

        <div className="bg-background border-t p-3">
          <ComposerPrimitive.Root className="flex w-full max-w-3xl items-end gap-2">
            <ComposerPrimitive.Input
              placeholder="Ask about Langfuse..."
              submitMode="enter"
              minRows={1}
              rows={1}
              className="bg-background shadow-x flex-1 resize-none overflow-y-auto rounded-xl px-3 py-2 text-sm leading-5"
            />
            <ComposerPrimitive.Send asChild>
              <Button
                size="icon"
                className="h-10 w-10 rounded-xl"
                aria-label="Send message"
              >
                <SendHorizontal className="h-4 w-4" />
              </Button>
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </section>
  );
}

function AssistantSidebarMessage() {
  const role = useAuiState((state) => state.message.role);
  const isLoading = useAuiState((state) =>
    state.message.parts.every((part) => part.type === "reasoning"),
  );

  if (role === "system") {
    return null;
  }

  const isUser = role === "user";

  return (
    <MessagePrimitive.Root className={"flex w-full"}>
      <div
        className={cn(
          "rounded-2xl px-4 py-3 text-sm shadow-xs",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card text-card-foreground border-border border",
        )}
      >
        {isLoading ? (
          <ThinkingIndicator />
        ) : (
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type !== "text") {
                return null;
              }

              return (
                <MessagePartTextValue>
                  {({ text }) => {
                    if (isUser) {
                      return (
                        <p className="leading-6 whitespace-pre-wrap">{text}</p>
                      );
                    }

                    if (!text.trim()) {
                      return (
                        <ThinkingIndicator className="text-muted-foreground" />
                      );
                    }

                    return (
                      <div className="assistant-streamdown text-sm leading-6">
                        <Streamdown>{text}</Streamdown>
                      </div>
                    );
                  }}
                </MessagePartTextValue>
              );
            }}
          </MessagePrimitive.Parts>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

function MessagePartTextValue<T>({
  children,
}: {
  children: ReactNode | ((value: { text: string }) => T);
}) {
  const { text } = useMessagePartText();

  if (typeof children === "function") {
    return children({ text });
  }

  return children;
}

function ThinkingIndicator({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-sm", className)}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>Thinking...</span>
    </div>
  );
}
