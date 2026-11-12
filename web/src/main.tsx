import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./console/App";
import { ApiError } from "./console/api";
import "./console/style.css";

const client = new QueryClient({ defaultOptions: { queries: {
  staleTime: 2_000,
  retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status < 500),
} } });

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={client}><App /></QueryClientProvider></StrictMode>,
);
