"use client";

import { type PropsWithChildren } from "react";
import { useMediaQuery } from "react-responsive";
import { Bot } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { ResizableDesktopLayout } from "@/src/components/layouts/ResizableDesktopLayout";
import { useAssistantSidebar } from "./AssistantSidebarProvider";
import { AssistantSidebarPanel } from "./AssistantSidebarPanel";

export function AssistantShell({ children }: PropsWithChildren) {
  const isDesktop = useMediaQuery({ query: "(min-width: 1024px)" });
  const { open } = useAssistantSidebar();
  const launcher = !open ? <AssistantLauncher /> : null;

  if (!isDesktop) {
    return children;
  }

  return (
    <div className="relative h-full w-full">
      <ResizableDesktopLayout
        mainContent={
          <>
            {children}
            {launcher}
          </>
        }
        sidebarContent={<AssistantSidebarPanel />}
        open={open}
        defaultMainSize={72}
        defaultSidebarSize={28}
        minMainSize={35}
        maxSidebarSize={45}
        persistId="assistant-sidebar"
      />
    </div>
  );
}

function AssistantLauncher() {
  const { setOpen } = useAssistantSidebar();

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 md:right-6 md:bottom-6">
      <Button
        className="pointer-events-auto h-11 rounded-full px-4 shadow-lg"
        onClick={() => setOpen(true)}
      >
        <Bot className="mr-2 h-4 w-4" />
        Assistant
      </Button>
    </div>
  );
}
