import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import "@/styles/index.css";

// Press animations only for pointer input, as in AntQuant.
window.addEventListener("pointerdown", () => {
  document.documentElement.dataset.input = "pointer";
}, { capture: true, passive: true });
window.addEventListener("keydown", () => {
  document.documentElement.dataset.input = "keyboard";
}, { capture: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      refetchOnWindowFocus: true,
      retry: (count, err) =>
        count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
