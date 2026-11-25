import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { Reader } from "maxmind";

import {
  createCountryDatabaseLifecycle,
  createCountryDatabaseManager,
  createCountryLookup,
  getGeoLiteCountryRuntimeConfig,
  lookupCountryForIp,
} from "../app/features/widgets/country-database.server.ts";
import { startCountryDatabaseBackgroundLifecycle } from "../scripts/country-database-lifecycle.mjs";
import { filterByCountryTargeting } from "../app/features/widgets/country-targeting.server.ts";
import { resolveVisitorCountry } from "../app/features/widgets/country-resolution.server.ts";
import { COUNTRY_TARGETING_MODES } from "../app/features/widgets/country-targeting.shared.ts";

const FIXTURE_PATH = new URL(
  "./fixtures/GeoIP2-Country-Test.mmdb",
  import.meta.url,
);
const TEST_CREDENTIALS = {
  enabled: true,
  accountId: "123456",
  licenseKey: "test-license-secret",
};

function testDatabase(countryCode, buildAt) {
  return Buffer.from(`${countryCode}\n${new Date(buildAt).toISOString()}`);
}

function tarHeader(path, size, type = "0") {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "ascii");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function makeTar(entries, { terminate = true } = {}) {
  const blocks = [];
  for (const { path, type = "0", data = Buffer.alloc(0) } of entries) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    blocks.push(tarHeader(path, bytes.length, type));
    if (bytes.length > 0) {
      blocks.push(bytes);
      const padding = (512 - (bytes.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  if (terminate) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function makeArchiveFor(buildAt, databaseBytes, extraEntries = []) {
  const date = new Date(buildAt).toISOString().slice(0, 10).replaceAll("-", "");
  const root = `GeoLite2-Country_${date}`;
  const entries = [
    { path: `${root}/`, type: "5" },
    ...extraEntries,
    { path: `${root}/GeoLite2-Country.mmdb`, data: databaseBytes },
  ];
  return gzipSync(makeTar(entries));
}

function fakeReaderFactory(databaseBytes) {
  const [countryCode, buildTime] = databaseBytes.toString().split("\n");
  return {
    metadata: {
      databaseType: "GeoLite2-Country",
      buildEpoch: new Date(buildTime),
    },
    get() {
      return countryCode === "NONE"
        ? null
        : { country: { iso_code: countryCode } };
    },
  };
}

function createProvider({
  releaseAt,
  archive,
  headStatus = 200,
  downloadStatus = 200,
  beforeRequest,
  downloadHeaders = {},
} = {}) {
  const requests = [];
  let latestReleaseAt = releaseAt;
  let latestArchive = archive;
  let latestHeadStatus = headStatus;
  let latestDownloadStatus = downloadStatus;

  const fetcher = async (input, init = {}) => {
    const request = {
      method: init.method,
      url: new URL(input).href,
      headers: new Headers(init.headers),
      redirect: init.redirect,
    };
    requests.push(request);
    await beforeRequest?.(request);

    if (request.method === "HEAD") {
      if (latestHeadStatus !== 200) {
        return new Response(null, { status: latestHeadStatus });
      }
      return new Response(null, {
        status: 200,
        headers: {
          "last-modified": new Date(latestReleaseAt).toUTCString(),
        },
      });
    }

    if (latestDownloadStatus !== 200) {
      return new Response("provider error body", {
        status: latestDownloadStatus,
      });
    }
    return new Response(latestArchive, {
      status: 200,
      headers: downloadHeaders,
    });
  };

  return {
    fetcher,
    requests,
    setRelease(release, nextArchive) {
      latestReleaseAt = release;
      latestArchive = nextArchive;
    },
    setHeadStatus(status) {
      latestHeadStatus = status;
    },
    setDownloadStatus(status) {
      latestDownloadStatus = status;
    },
  };
}

function makeTimerHarness() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    scheduleTimer(callback, delayMs) {
      const timer = { callback, delayMs };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
      cleared.push(timer);
    },
  };
}

function createObservedFileSystem() {
  const directories = [];
  const fileModes = new Map();
  const renames = [];
  return {
    directories,
    fileModes,
    renames,
    async mkdtemp(prefix) {
      const directory = await mkdtemp(prefix);
      directories.push(directory);
      return directory;
    },
    readFile,
    async rename(from, to) {
      let targetBefore = null;
      try {
        targetBefore = await readFile(to);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      renames.push({ from, to, targetBefore });
      await rename(from, to);
    },
    rm,
    async writeFile(path, bytes, options) {
      fileModes.set(path, options.mode);
      await writeFile(path, bytes, options);
    },
  };
}

function standardArchive(countryCode, buildAt) {
  return makeArchiveFor(buildAt, testDatabase(countryCode, buildAt));
}

function managerFor(t, provider, options = {}) {
  const manager = createCountryDatabaseManager({
    fetcher: provider.fetcher,
    fileSystem: options.fileSystem,
    now: options.now,
    operationTimeoutMs: options.operationTimeoutMs,
    readerFactory: options.readerFactory ?? fakeReaderFactory,
    extractor: options.extractor,
    onError: options.onError ?? (() => {}),
    scheduleTimer: options.timers?.scheduleTimer,
    clearTimer: options.timers?.clearTimer,
  });
  t.after(() => manager.stop());
  return manager;
}

function makeProcessHarness() {
  const listeners = new Map();
  return {
    listeners,
    on(signal, callback) {
      const callbacks = listeners.get(signal) ?? [];
      callbacks.push({ callback, once: false });
      listeners.set(signal, callbacks);
    },
    once(signal, callback) {
      const callbacks = listeners.get(signal) ?? [];
      callbacks.push({ callback, once: true });
      listeners.set(signal, callbacks);
    },
    emit(signal) {
      const callbacks = listeners.get(signal) ?? [];
      listeners.set(
        signal,
        callbacks.filter(({ once }) => !once),
      );
      for (const { callback } of callbacks) callback();
    },
  };
}

test("the official small MMDB fixture exercises country lookup for IPv4 and IPv6", async () => {
  const database = await readFile(FIXTURE_PATH);
  const reader = new Reader(database);
  const lookup = createCountryLookup(reader);

  assert.equal(lookup("81.2.69.160"), "GB");
  assert.equal(lookup("89.160.20.128"), "SE");
  assert.equal(lookup("2001:218::1"), "JP");
  assert.equal(lookup("1.1.1.1"), null);
  assert.equal(lookup("not-an-ip"), null);
  assert.equal(lookup(""), null);
  assert.equal(lookup("192.0.2.1"), null);
  assert.equal(lookup("198.51.100.1"), null);
  assert.equal(lookup("::1"), null);
  assert.equal(lookup("fc00::1"), null);
  assert.equal(lookup("2001:db8::1"), null);
  assert.equal(lookup("::ffff:8.8.8.8"), null);
});

test("the country adapter accepts only supported country.iso_code values", () => {
  const lookupUnsupported = createCountryLookup({
    get: () => ({ country: { iso_code: "XK" } }),
  });
  const lookupNoCountry = createCountryLookup({
    get: () => ({
      registered_country: { iso_code: "GB" },
    }),
  });

  assert.equal(lookupUnsupported("8.8.8.8"), null);
  assert.equal(lookupNoCountry("8.8.8.8"), null);
});

test("missing or partial runtime configuration disables the manager", async (t) => {
  const provider = createProvider({
    releaseAt: Date.UTC(2026, 10, 20),
    archive: standardArchive("GB", Date.UTC(2026, 10, 20)),
  });
  const manager = managerFor(t, provider);

  assert.deepEqual(
    getGeoLiteCountryRuntimeConfig({
      MAXMIND_ACCOUNT_ID: "123456",
    }),
    {
      enabled: false,
      accountId: "123456",
      licenseKey: undefined,
    },
  );
  assert.deepEqual(await manager.start({}), { status: "disabled" });
  assert.deepEqual(
    await manager.start({
      accountId: TEST_CREDENTIALS.accountId,
    }),
    { status: "disabled" },
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(await manager.lookup("8.8.8.8"), null);
  assert.equal(
    getGeoLiteCountryRuntimeConfig({
      NOTICEPRO_GEOIP_ENABLED: "TRUE",
      MAXMIND_ACCOUNT_ID: "123456",
      MAXMIND_LICENSE_KEY: "test-license-secret",
    }).enabled,
    false,
  );
  assert.equal(
    getGeoLiteCountryRuntimeConfig({
      NOTICEPRO_GEOIP_ENABLED: "true",
      MAXMIND_ACCOUNT_ID: "123456",
      MAXMIND_LICENSE_KEY: "test-license-secret",
    }).enabled,
    true,
  );
});

test("disabled and invalid process configuration creates no manager, requests, or timers", async () => {
  let managerCreations = 0;
  const disabled = createCountryDatabaseLifecycle({
    readConfig: () => getGeoLiteCountryRuntimeConfig({}),
    createManager: () => {
      managerCreations += 1;
      throw new Error("disabled lifecycle must not create a manager");
    },
  });

  assert.deepEqual(await disabled.initialize(), { status: "disabled" });
  assert.equal(disabled.isEnabled(), false);
  assert.equal(disabled.isReady(), false);
  assert.equal(await disabled.lookup("8.8.8.8"), null);
  assert.equal(managerCreations, 0);
  assert.deepEqual(await disabled.stop(), { status: "stopped" });

  const invalid = createCountryDatabaseLifecycle({
    readConfig: () => ({
      enabled: true,
      accountId: "not-an-account-id",
      licenseKey: TEST_CREDENTIALS.licenseKey,
    }),
    createManager: () => {
      managerCreations += 1;
      throw new Error("invalid configuration must not create a manager");
    },
  });
  assert.deepEqual(await invalid.initialize(), { status: "disabled" });
  assert.equal(invalid.isEnabled(), false);
  assert.equal(invalid.isReady(), false);
  assert.equal(managerCreations, 0);
});

test("a missing lifecycle bridge disables GeoIP without failing server startup", async () => {
  const processHarness = makeProcessHarness();
  const messages = [];
  const originalError = console.error;
  console.error = (message) => messages.push(message);

  try {
    const startup = startCountryDatabaseBackgroundLifecycle(
      undefined,
      processHarness,
    );
    assert.deepEqual(await startup.initialization, { status: "disabled" });
    assert.equal(processHarness.listeners.size, 0);
  } finally {
    console.error = originalError;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /continuing with country resolution disabled/);
});

test("synchronous GeoIP initialization failure cannot block the server entrypoint", async () => {
  const processHarness = makeProcessHarness();
  const originalError = console.error;
  const messages = [];
  console.error = (message) => messages.push(message);

  try {
    const startup = startCountryDatabaseBackgroundLifecycle(
      {
        initialize() {
          throw new Error("initialization failure");
        },
        isEnabled: () => false,
        stop: async () => ({ status: "stopped" }),
      },
      processHarness,
    );
    let servingStarted = false;
    servingStarted = true;

    await assert.rejects(startup.initialization);
    assert.equal(servingStarted, true);
    assert.equal(processHarness.listeners.size, 0);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(messages, [
    "NoticePro country database initialization failed.",
  ]);
});

test("process signal shutdown permits asynchronous cleanup to finish naturally", () => {
  const lifecycleModule = new URL(
    "../scripts/country-database-lifecycle.mjs",
    import.meta.url,
  ).href;
  const childSource = `
    import { startCountryDatabaseBackgroundLifecycle } from ${JSON.stringify(lifecycleModule)};
    const lifecycle = {
      initialize: () => Promise.resolve({ status: "ready" }),
      isEnabled: () => true,
      stop: () => new Promise((resolve) => {
        setTimeout(() => {
          process.stdout.write("cleanup-finished");
          resolve({ status: "stopped" });
        }, 25);
      }),
    };
    startCountryDatabaseBackgroundLifecycle(lifecycle);
    setTimeout(() => process.emit("SIGTERM"), 0);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childSource],
    { encoding: "utf8", timeout: 2_000 },
  );

  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cleanup-finished/);
});

test("enabled server lifecycle starts once in the background and stops without waiting for remote I/O", async () => {
  const releaseAt = Date.UTC(2026, 10, 20);
  let releaseHead;
  let headStarted;
  const headWasStarted = new Promise((resolve) => {
    headStarted = resolve;
  });
  const headCanFinish = new Promise((resolve) => {
    releaseHead = resolve;
  });
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
    beforeRequest: async ({ method }) => {
      if (method === "HEAD") {
        headStarted();
        await headCanFinish;
      }
    },
  });
  const timers = makeTimerHarness();
  let managerCreations = 0;
  const lifecycle = createCountryDatabaseLifecycle({
    readConfig: () => TEST_CREDENTIALS,
    managerOptions: {
      fetcher: provider.fetcher,
      readerFactory: fakeReaderFactory,
      onError: () => {},
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
      operationTimeoutMs: 1_000,
    },
    createManager: () => {
      managerCreations += 1;
      return createCountryDatabaseManager({
        fetcher: provider.fetcher,
        readerFactory: fakeReaderFactory,
        onError: () => {},
        scheduleTimer: timers.scheduleTimer,
        clearTimer: timers.clearTimer,
        operationTimeoutMs: 1_000,
      });
    },
  });
  const processHarness = makeProcessHarness();
  processHarness.on("SIGTERM", () => {});

  const started = startCountryDatabaseBackgroundLifecycle(
    lifecycle,
    processHarness,
  );
  await headWasStarted;
  const repeated = startCountryDatabaseBackgroundLifecycle(
    lifecycle,
    processHarness,
  );
  let initializationSettled = false;
  void started.initialization.then(() => {
    initializationSettled = true;
  });

  assert.equal(managerCreations, 1);
  assert.equal(started.initialization, repeated.initialization);
  assert.equal(lifecycle.isEnabled(), true);
  assert.equal(await lifecycle.lookup("8.8.8.8"), null);
  assert.equal(initializationSettled, false);
  assert.equal(processHarness.listeners.get("SIGTERM").length, 2);
  assert.equal(processHarness.listeners.get("SIGINT").length, 1);

  let healthCompleted = false;
  await Promise.resolve().then(() => {
    healthCompleted = true;
  });
  assert.equal(healthCompleted, true);
  assert.equal(initializationSettled, false);

  processHarness.emit("SIGTERM");
  let shutdownGuard;
  const initializationResult = await Promise.race([
    started.initialization,
    new Promise((_, reject) => {
      shutdownGuard = setTimeout(
        () => reject(new Error("Country manager shutdown was not bounded.")),
        500,
      );
    }),
  ]);
  clearTimeout(shutdownGuard);
  assert.deepEqual(initializationResult, { status: "stopped" });
  assert.deepEqual(await lifecycle.stop(), { status: "stopped" });
  releaseHead();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    provider.requests.filter(({ method }) => method === "GET").length,
    0,
  );
  assert.equal(await lifecycle.lookup("8.8.8.8"), null);
});

test("the manager reuses one initialized reader for repeated lookups", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
  });
  let readerCreations = 0;
  let readerLookups = 0;
  const manager = managerFor(t, provider, {
    readerFactory: (database) => {
      readerCreations += 1;
      const reader = fakeReaderFactory(database);
      return {
        metadata: reader.metadata,
        get(ipAddress) {
          readerLookups += 1;
          return reader.get(ipAddress);
        },
      };
    },
  });

  assert.equal(manager.isReady(), false);
  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  assert.equal(manager.isReady(), true);
  assert.equal(await manager.lookup("81.2.69.160"), "GB");
  assert.equal(await manager.lookup("8.8.8.8"), "GB");
  assert.equal(readerCreations, 1);
  assert.equal(readerLookups, 2);
  assert.deepEqual(await manager.stop(), { status: "stopped" });
  assert.equal(manager.isReady(), false);
});

test("a current build is checked without downloading it again", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
  });
  const manager = managerFor(t, provider);

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  assert.equal((await manager.refresh()).status, "ready");
  assert.equal(
    provider.requests.filter(({ method }) => method === "HEAD").length,
    2,
  );
  assert.equal(
    provider.requests.filter(({ method }) => method === "GET").length,
    1,
  );
});

test("concurrent starts and refreshes share one provider update", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  let releaseHead;
  let headStarted;
  const headWasStarted = new Promise((resolve) => {
    headStarted = resolve;
  });
  const headCanFinish = new Promise((resolve) => {
    releaseHead = resolve;
  });
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
    beforeRequest: async ({ method }) => {
      if (method === "HEAD") {
        headStarted();
        await headCanFinish;
      }
    },
  });
  const manager = managerFor(t, provider);

  const firstStart = manager.start(TEST_CREDENTIALS);
  await headWasStarted;
  const secondStart = manager.start(TEST_CREDENTIALS);
  const refresh = manager.refresh();
  assert.equal(firstStart, secondStart);
  assert.equal(firstStart, refresh);
  releaseHead();
  await Promise.all([firstStart, secondStart, refresh]);

  assert.equal(
    provider.requests.filter(({ method }) => method === "HEAD").length,
    1,
  );
  assert.equal(
    provider.requests.filter(({ method }) => method === "GET").length,
    1,
  );
});

test("the provider request uses HTTPS Basic auth and follows only its documented storage redirect", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const archive = standardArchive("GB", releaseAt);
  const requests = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({
      method: init.method,
      url,
      authorization: new Headers(init.headers).get("authorization"),
    });
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "last-modified": new Date(releaseAt).toUTCString() },
      });
    }
    if (url.hostname === "download.maxmind.com") {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://${"mm-prod-geoip-databases.a2649acb697e2c09b632799562c076f2.r2.cloudflarestorage.com"}/signed?sig=private-test-signature`,
        },
      });
    }
    return new Response(archive);
  };
  const provider = { fetcher };
  const manager = managerFor(t, provider);

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  assert.equal(requests[0].url.protocol, "https:");
  assert.equal(requests[0].url.username, "");
  assert.equal(requests[0].url.password, "");
  assert.match(requests[0].url.href, /suffix=tar\.gz$/);
  assert.equal(
    requests[0].authorization,
    `Basic ${Buffer.from(
      `${TEST_CREDENTIALS.accountId}:${TEST_CREDENTIALS.licenseKey}`,
    ).toString("base64")}`,
  );
  assert.equal(requests.at(-1).authorization, null);
  assert.equal(
    requests.at(-1).url.hostname,
    "mm-prod-geoip-databases.a2649acb697e2c09b632799562c076f2.r2.cloudflarestorage.com",
  );
});

test("unapproved or non-HTTPS redirects are rejected without requesting their destinations", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  for (const location of [
    "https://attacker.example/download",
    "http://mm-prod-geoip-databases.a2649acb697e2c09b632799562c076f2.r2.cloudflarestorage.com/download",
  ]) {
    const requests = [];
    const fetcher = async (input, init = {}) => {
      const url = new URL(input);
      requests.push({
        url,
        authorization: new Headers(init.headers).get("authorization"),
      });
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "last-modified": new Date(releaseAt).toUTCString() },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location },
      });
    };
    const manager = managerFor(t, { fetcher });

    assert.equal((await manager.start(TEST_CREDENTIALS)).status, "failed");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url.hostname, "download.maxmind.com");
  }
});

test("malformed, truncated, oversized, linked, traversing, and unexpected archives are rejected", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const root = "GeoLite2-Country_20261120";
  const validDatabase = testDatabase("GB", releaseAt);
  const cases = [
    ["malformed gzip", Buffer.from("not a gzip archive")],
    [
      "truncated tar",
      gzipSync(
        makeTar(
          [
            { path: `${root}/`, type: "5" },
            { path: `${root}/GeoLite2-Country.mmdb`, data: validDatabase },
          ],
          { terminate: false },
        ),
      ),
    ],
    [
      "path traversal",
      gzipSync(
        makeTar([
          { path: "../GeoLite2-Country_20261120/", type: "5" },
          {
            path: `${root}/GeoLite2-Country.mmdb`,
            data: validDatabase,
          },
        ]),
      ),
    ],
    [
      "link entry",
      gzipSync(
        makeTar([
          { path: `${root}/`, type: "5" },
          {
            path: `${root}/GeoLite2-Country.mmdb`,
            type: "2",
            data: "target",
          },
        ]),
      ),
    ],
    [
      "unexpected entry",
      gzipSync(
        makeTar([
          { path: `${root}/`, type: "5" },
          { path: `${root}/surprise.txt`, data: "unexpected" },
          {
            path: `${root}/GeoLite2-Country.mmdb`,
            data: validDatabase,
          },
        ]),
      ),
    ],
  ];

  for (const [label, archive] of cases) {
    const provider = createProvider({ releaseAt, archive });
    const manager = managerFor(t, provider);
    assert.equal(
      (await manager.start(TEST_CREDENTIALS)).status,
      "failed",
      label,
    );
    assert.equal(await manager.lookup("8.8.8.8"), null, label);
    await manager.stop();
  }

  const oversizedProvider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
    downloadHeaders: { "content-length": String(40 * 1024 * 1024) },
  });
  const oversizedManager = managerFor(t, oversizedProvider);
  assert.equal(
    (await oversizedManager.start(TEST_CREDENTIALS)).status,
    "failed",
    "oversized response",
  );
  assert.equal(await oversizedManager.lookup("8.8.8.8"), null);
});

test("authentication and download failures do not expose credentials or response bodies", async (t) => {
  const messages = [];
  const authFailureProvider = createProvider({
    releaseAt: Date.UTC(2026, 10, 20),
    archive: Buffer.alloc(0),
    headStatus: 401,
  });
  const authFailureManager = managerFor(t, authFailureProvider, {
    onError: (error) => messages.push(error.message),
  });

  assert.equal(
    (await authFailureManager.start(TEST_CREDENTIALS)).status,
    "failed",
  );
  assert.equal(
    authFailureProvider.requests[0].url.includes(TEST_CREDENTIALS.accountId),
    false,
  );
  assert.equal(
    authFailureProvider.requests[0].url.includes(TEST_CREDENTIALS.licenseKey),
    false,
  );

  const downloadFailureProvider = createProvider({
    releaseAt: Date.UTC(2026, 10, 20),
    archive: standardArchive("GB", Date.UTC(2026, 10, 20)),
    downloadStatus: 401,
  });
  const downloadFailureManager = managerFor(t, downloadFailureProvider, {
    onError: (error) => messages.push(error.message),
  });
  assert.equal(
    (await downloadFailureManager.start(TEST_CREDENTIALS)).status,
    "failed",
  );
  assert.equal(
    downloadFailureProvider.requests[0].url.includes(
      TEST_CREDENTIALS.licenseKey,
    ),
    false,
  );
  assert.equal(
    messages.some(
      (message) =>
        message.includes(TEST_CREDENTIALS.accountId) ||
        message.includes(TEST_CREDENTIALS.licenseKey) ||
        message.includes("provider error body"),
    ),
    false,
  );
});

test("an invalid replacement is rejected before the existing reader or file is swapped", async (t) => {
  const firstRelease = Date.UTC(2026, 10, 20);
  const secondRelease = Date.UTC(2026, 10, 22);
  const provider = createProvider({
    releaseAt: firstRelease,
    archive: standardArchive("GB", firstRelease),
  });
  const fileSystem = createObservedFileSystem();
  const errors = [];
  const manager = managerFor(t, provider, {
    fileSystem,
    onError: (error) => errors.push(error.message),
    readerFactory(database) {
      const reader = fakeReaderFactory(database);
      if (reader.metadata.buildEpoch.getTime() === secondRelease) {
        reader.metadata.databaseType = "GeoLite2-City";
      }
      return reader;
    },
  });

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  const directory = fileSystem.directories[0];
  const publishedPath = join(directory, "GeoLite2-Country.mmdb");
  const originalDatabase = await readFile(publishedPath);
  provider.setRelease(secondRelease, standardArchive("US", secondRelease));

  assert.equal((await manager.refresh()).status, "failed");
  assert.deepEqual(await readFile(publishedPath), originalDatabase);
  assert.equal(await manager.lookup("8.8.8.8"), "GB");
  assert.equal(fileSystem.renames.length, 1);
  assert.ok(errors[0].includes("update failed"));
  assert.deepEqual((await readdir(directory)).sort(), [
    "GeoLite2-Country.mmdb",
  ]);
});

test("a successful replacement publishes atomically and removes temporary copies", async (t) => {
  const firstRelease = Date.UTC(2026, 10, 20);
  const secondRelease = Date.UTC(2026, 10, 22);
  const provider = createProvider({
    releaseAt: firstRelease,
    archive: standardArchive("GB", firstRelease),
  });
  const fileSystem = createObservedFileSystem();
  const manager = managerFor(t, provider, { fileSystem });

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  const directory = fileSystem.directories[0];
  const publishedPath = join(directory, "GeoLite2-Country.mmdb");
  const oldDatabase = await readFile(publishedPath);
  provider.setRelease(secondRelease, standardArchive("US", secondRelease));

  assert.equal((await manager.refresh()).status, "ready");
  assert.equal(await manager.lookup("8.8.8.8"), "US");
  assert.notDeepEqual(await readFile(publishedPath), oldDatabase);
  assert.equal(fileSystem.renames.length, 2);
  assert.deepEqual(fileSystem.renames[1].targetBefore, oldDatabase);
  assert.ok([...fileSystem.fileModes.values()].every((mode) => mode === 0o600));
  assert.equal((await stat(publishedPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), [
    "GeoLite2-Country.mmdb",
  ]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("failed refresh removes an old database before MaxMind's 30-day deadline", async (t) => {
  const firstRelease = Date.UTC(2026, 10, 1);
  const newerRelease = Date.UTC(2026, 10, 5);
  let currentTime = Date.UTC(2026, 10, 6);
  const timers = makeTimerHarness();
  const fileSystem = createObservedFileSystem();
  const provider = createProvider({
    releaseAt: firstRelease,
    archive: standardArchive("GB", firstRelease),
  });
  const manager = managerFor(t, provider, {
    now: () => currentTime,
    fileSystem,
    timers,
  });

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  provider.setRelease(newerRelease, standardArchive("US", newerRelease));
  provider.setDownloadStatus(503);
  assert.equal((await manager.refresh()).status, "failed");
  assert.equal(await manager.lookup("8.8.8.8"), "GB");

  const expiry = newerRelease + 30 * 24 * 60 * 60 * 1000;
  const checkInterval = 6 * 60 * 60 * 1000;
  while (currentTime + checkInterval < expiry) {
    currentTime += checkInterval;
    assert.equal((await manager.refresh()).status, "failed");
  }
  currentTime = expiry - 60_001;
  assert.equal(await manager.lookup("8.8.8.8"), "GB");
  currentTime = expiry - 59_999;
  assert.equal(await manager.lookup("8.8.8.8"), null);
  const publishedPath = join(
    fileSystem.directories[0],
    "GeoLite2-Country.mmdb",
  );
  await assert.rejects(stat(publishedPath), { code: "ENOENT" });
  currentTime = expiry;
  assert.equal(await manager.lookup("8.8.8.8"), null);
  provider.setDownloadStatus(200);
  assert.equal((await manager.refresh()).status, "ready");
  assert.equal(await manager.lookup("8.8.8.8"), "US");
});

test("an unverified provider freshness check makes selected-country lookup unknown", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
  });
  const manager = managerFor(t, provider);

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  assert.equal(await manager.lookup("8.8.8.8"), "GB");
  provider.setHeadStatus(503);
  assert.equal((await manager.refresh()).status, "failed");
  assert.equal(await manager.lookup("8.8.8.8"), null);
});

test("overdue freshness checks fail closed until the provider is checked again", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  let currentTime = releaseAt;
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
  });
  const manager = managerFor(t, provider, { now: () => currentTime });

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  assert.equal(await manager.lookup("8.8.8.8"), "GB");
  currentTime += 6 * 60 * 60 * 1000 + 15_001;
  assert.equal(await manager.lookup("8.8.8.8"), null);

  assert.equal((await manager.refresh()).status, "ready");
  assert.equal(await manager.lookup("8.8.8.8"), "GB");
});

test("retry delays are bounded and transition to the regular update interval", async (t) => {
  const timers = makeTimerHarness();
  const provider = createProvider({
    releaseAt: Date.UTC(2026, 10, 20),
    archive: Buffer.alloc(0),
    headStatus: 503,
  });
  const manager = managerFor(t, provider, { timers });

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "failed");
  const expectedDelays = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60 * 1000];
  for (const delay of expectedDelays) {
    const timer = timers.scheduled.at(-1);
    assert.equal(timer.delayMs, delay);
    timer.callback();
    await manager.refresh();
  }
  assert.equal(
    provider.requests.filter(({ method }) => method === "HEAD").length,
    expectedDelays.length + 1,
  );
});

test("stop clears timers, closes lookup, and removes only its private files", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
  });
  const fileSystem = createObservedFileSystem();
  const timers = makeTimerHarness();
  const manager = managerFor(t, provider, { fileSystem, timers });

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "ready");
  const directory = fileSystem.directories[0];
  assert.equal(await manager.lookup("8.8.8.8"), "GB");

  assert.deepEqual(await manager.stop(), { status: "stopped" });
  assert.equal(timers.cleared.length, 1);
  assert.equal(await manager.lookup("8.8.8.8"), null);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.deepEqual(await manager.start(TEST_CREDENTIALS), {
    status: "stopped",
  });
});

test("stop waits for an in-flight check and prevents a late download from publishing", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  let releaseHead;
  let headStarted;
  const headWasStarted = new Promise((resolve) => {
    headStarted = resolve;
  });
  const headCanFinish = new Promise((resolve) => {
    releaseHead = resolve;
  });
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
    beforeRequest: async ({ method }) => {
      if (method === "HEAD") {
        headStarted();
        await headCanFinish;
      }
    },
  });
  const manager = managerFor(t, provider);

  const starting = manager.start(TEST_CREDENTIALS);
  await headWasStarted;
  const stopping = manager.stop();
  releaseHead();
  assert.deepEqual(await starting, { status: "stopped" });
  assert.deepEqual(await stopping, { status: "stopped" });
  assert.equal(
    provider.requests.filter(({ method }) => method === "GET").length,
    0,
  );
  assert.equal(await manager.lookup("8.8.8.8"), null);
});

test("the total operation deadline covers a stalled response body", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const fetcher = async (_input, init = {}) => {
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "last-modified": new Date(releaseAt).toUTCString() },
      });
    }
    return new Response(
      new ReadableStream({
        start() {},
      }),
      { status: 200 },
    );
  };
  const manager = managerFor(t, { fetcher }, { operationTimeoutMs: 20 });
  const startedAt = Date.now();

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "failed");
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(await manager.lookup("8.8.8.8"), null);
});

test("the total operation deadline covers a stalled archive extraction", async (t) => {
  const releaseAt = Date.UTC(2026, 10, 20);
  const provider = createProvider({
    releaseAt,
    archive: standardArchive("GB", releaseAt),
  });
  const fileSystem = createObservedFileSystem();
  const manager = managerFor(t, provider, {
    fileSystem,
    operationTimeoutMs: 20,
    extractor: () => new Promise(() => {}),
  });
  const startedAt = Date.now();

  assert.equal((await manager.start(TEST_CREDENTIALS)).status, "failed");
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(fileSystem.directories.length, 1);
  await assert.rejects(
    stat(join(fileSystem.directories[0], "GeoLite2-Country.mmdb")),
    { code: "ENOENT" },
  );
});

test("unattested visitors remain unknown and ALL targeting is unaffected", async () => {
  const request = new Request("https://shop.test/apps/notice-pro", {
    headers: {
      "x-forwarded-for": "81.2.69.160",
      "cf-connecting-ip": "81.2.69.160",
    },
  });
  const candidates = [
    {
      id: "all",
      countryTargetingMode: COUNTRY_TARGETING_MODES.ALL,
      targetCountryCodes: [],
    },
    {
      id: "selected",
      countryTargetingMode: COUNTRY_TARGETING_MODES.SELECTED,
      targetCountryCodes: ["GB"],
    },
  ];

  assert.equal(await lookupCountryForIp("81.2.69.160"), null);
  assert.equal(await resolveVisitorCountry(request, "shop.test"), null);
  assert.deepEqual(
    (
      await filterByCountryTargeting(
        candidates,
        request,
        "shop.test",
        async () => null,
      )
    ).map(({ id }) => id),
    ["all"],
  );
});
