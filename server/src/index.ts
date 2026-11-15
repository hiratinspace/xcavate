import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadEnv, resolveDbPath } from "./env.js";
import { createLlm } from "./llm/index.js";
import { logStartup } from "./log.js";
import { openStore } from "./store/index.js";

loadEnv();
const config = loadConfig();
const store = openStore(resolveDbPath(config.dbPath), config.store);
const llm = createLlm(config);
const app = createApp({ store, llm, config });

const server = app.listen(config.port, () => {
  logStartup(config.port, llm.provider, store.kind);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
