import { BridgeService } from "./bridge";
import { loadConfig, type AppPaths, writeRuntimeSnapshot } from "./config";

export async function runServer(paths: AppPaths): Promise<void> {
  const config = await loadConfig(paths);
  if (config.bridgeBlockers.length > 0) {
    for (const blocker of config.bridgeBlockers) {
      console.error(blocker);
    }
    console.error("Run `whiscord setup` first.");
    return;
  }

  const bridge = new BridgeService(config);
  const store = bridge.getStore();
  let lastEventAt = 0;

  const unsubscribe = store.subscribe((snapshot) => {
    void writeRuntimeSnapshot(paths, snapshot);

    const newest = snapshot.events[0];
    if (newest && newest.at !== lastEventAt) {
      lastEventAt = newest.at;
      console.log(
        `[${new Date(newest.at).toLocaleTimeString()}] ${newest.level.toUpperCase()} ${newest.message}`,
      );
    }
  });

  await bridge.start();

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);

      void bridge.stop().finally(() => {
        unsubscribe();
        resolve();
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
