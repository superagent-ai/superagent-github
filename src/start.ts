import { spawn } from "node:child_process";
import path from "node:path";

const fluePort = process.env.FLUE_PORT ?? "3583";
const flueServerPath = path.resolve(".flue-dist/server.mjs");

const flue = spawn(process.execPath, [flueServerPath], {
  env: {
    ...process.env,
    PORT: fluePort,
  },
  stdio: "inherit",
});

flue.on("exit", (code, signal) => {
  console.error(`Flue server exited with ${signal ?? code}`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    flue.kill(signal);
    process.exit(0);
  });
}

await import("./index.js");
