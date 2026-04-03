import { getAppPaths } from "./config";
import { runServer } from "./server";
import { runSetup } from "./setup";

const mode = Bun.argv[2] ?? "server";
const paths = getAppPaths();

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  switch (mode) {
    case "setup": {
      await runSetup(paths);
      break;
    }

    case "server": {
      await runServer(paths);
      break;
    }

    default: {
      console.error(`Unknown mode: ${mode}`);
      console.error("Use one of: setup, server");
      process.exitCode = 1;
    }
  }
}
