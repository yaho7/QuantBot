import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "quantbot-browser-"));
const binary = join(temporary, "quantbot");
execFileSync("go", ["build", "-o", binary, "./cmd/quantbot"], { cwd: resolve(".."), stdio: "inherit" });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QB_")));
const service = spawn(binary, ["serve"], { env: { ...env, QB_DATA_DIR: join(temporary, "data"), QB_LISTEN: "127.0.0.1:42357" }, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => service.kill("SIGTERM"));
service.on("exit", code => { rmSync(temporary, { recursive: true, force: true }); process.exit(code ?? 0); });
