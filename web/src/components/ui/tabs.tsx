import * as T from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;

export function TabsList({ className, ...p }: React.ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn("inline-flex h-9 items-center gap-1 rounded-full bg-muted p-1", className)}
      {...p}
    />
  );
}

export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "press-feedback inline-flex h-7 items-center rounded-full px-3.5 text-xs font-medium text-muted-foreground transition-colors data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs",
        className,
      )}
      {...p}
    />
  );
}

export function TabsContent({ className, ...p }: React.ComponentProps<typeof T.Content>) {
  return <T.Content className={cn("tab-panel mt-4", className)} {...p} />;
}
