"use client";

import {
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
} from "react";
import { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import useLocalStorage from "@/src/components/useLocalStorage";
import { env } from "@/src/env.mjs";
import useIsFeatureEnabled from "@/src/features/feature-flags/hooks/useIsFeatureEnabled";

const ASSISTANT_SIDEBAR_STORAGE_KEY = "assistant-sidebar:open";

const AssistantSidebarContext = createContext<ReturnType<
  typeof useAssistantSidebarValue
> | null>(null);

export function AssistantSidebarProvider({ children }: PropsWithChildren) {
  const assistantEnabled = useIsFeatureEnabled("inAppAgent");
  const value = useAssistantSidebarValue();
  const [agent] = useState(() => {
    return new HttpAgent({
      url: `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/in-app-agent`,
    });
  });

  const runtime = useAgUiRuntime({
    agent,
    showThinking: true,
    onError: (error) => {
      console.error("Assistant sidebar error", error);
    },
  });

  if (!assistantEnabled) {
    return children;
  }

  return (
    <AssistantSidebarContext.Provider value={value}>
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </AssistantSidebarContext.Provider>
  );
}

export function useAssistantSidebar() {
  const context = useContext(AssistantSidebarContext);

  if (!context) {
    throw new Error(
      "useAssistantSidebar must be used within AssistantSidebarProvider",
    );
  }

  return context;
}

function useAssistantSidebarValue() {
  const [open, setOpen] = useLocalStorage(ASSISTANT_SIDEBAR_STORAGE_KEY, true);

  return {
    open,
    setOpen,
  };
}
