import { useQueries } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, type Command } from "./api";
import { stateText } from "./ui";

let tracked: Command[] = [];
const subscribers = new Set<() => void>();
const active = new Set(["pending", "accepted", "executing", "confirmation_required"]);
function subscribe(listener: () => void) {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
function replace(commands: Command[]) {
  tracked = commands;
  subscribers.forEach((listener) => listener());
}
function show(command: Command) {
  const options = { id: command.id, action: { label: "查看指令", onClick: () => { location.hash = `#operations/${command.id}`; } } };
  if (command.state === "succeeded") toast.success(stateText[command.state], options);
  else if (command.state === "failed" || command.state === "unknown" || command.state === "expired") {
    toast.error(stateText[command.state], options);
  } else toast(stateText[command.state], options);
}
export function submitted(command: Command) {
  if (command.state === "pending") toast("已发送 · 等待策略确认", { id: command.id });
  else show(command);
  if (active.has(command.state)) replace([...tracked.filter((item) => item.id !== command.id), command]);
}
export function CommandFeedback() {
  const commands = useSyncExternalStore(subscribe, () => tracked);
  const queries = useQueries({
    queries: commands.map((command) => ({
      queryKey: ["live", `commands/${command.id}`],
      queryFn: () => api<Command>(`commands/${command.id}`),
      initialData: command,
      refetchInterval: 3_000,
    })),
  });
  useEffect(() => {
    const updated = commands.flatMap((command, index) => {
      const result = queries[index]?.data ?? command;
      if (result.state !== command.state) show(result);
      return active.has(result.state) ? [result] : [];
    });
    if (updated.length !== commands.length || updated.some((command, i) => command !== commands[i])) replace(updated);
  }, [commands, queries]);
  return null;
}
