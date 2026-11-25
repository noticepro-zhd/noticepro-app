import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startCountryDatabaseBackgroundLifecycle } from "./country-database-lifecycle.mjs";

process.env.NODE_ENV ??= "production";

const serverBuildPath = resolve(
  process.argv[2] ?? "build/server/index.js",
);
await import(pathToFileURL(serverBuildPath).href);

const lifecycle = globalThis.__noticeproGeoLiteCountryLifecycle__;
startCountryDatabaseBackgroundLifecycle(lifecycle);
