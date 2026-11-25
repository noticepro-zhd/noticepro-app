import { isIP } from "node:net";
import {
  mkdtemp as fsMkdtemp,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { Reader, type CountryResponse } from "maxmind";

import { SUPPORTED_COUNTRY_CODES } from "./country-data.ts";

const DATABASE_TYPE = "GeoLite2-Country";
const DOWNLOAD_URL =
  "https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz";
const REDIRECT_HOST =
  "mm-prod-geoip-databases.a2649acb697e2c09b632799562c076f2.r2.cloudflarestorage.com";
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_DATABASE_BYTES = 96 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_OPERATION_TIMEOUT_MS = 30_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FRESHNESS_CHECK_MAX_AGE_MS = UPDATE_INTERVAL_MS + REQUEST_TIMEOUT_MS;
const MAXMIND_DATABASE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DATABASE_EXPIRY_SAFETY_MARGIN_MS = 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_REDIRECTS = 2;
const TARBLOCK_BYTES = 512;

type CountryDatabaseRecord = {
  metadata: {
    databaseType: string;
    buildEpoch: Date;
  };
  get(ipAddress: string): CountryResponse | null;
};

type CountryReaderFactory = (database: Buffer) => CountryDatabaseRecord;
type CountryDatabaseArchiveExtractor = (
  archive: Buffer,
  signal: AbortSignal,
) => Promise<Buffer>;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type GeoLiteCountryConfig = Readonly<{
  enabled: boolean;
  accountId?: string | null;
  licenseKey?: string | null;
}>;

type FileSystem = {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(
    path: string,
    options: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
  writeFile(
    path: string,
    data: Buffer,
    options: { flag: string; mode: number },
  ): Promise<void>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type CountryDatabaseManagerOptions = Readonly<{
  fetcher?: typeof fetch;
  fileSystem?: FileSystem;
  now?: () => number;
  operationTimeoutMs?: number;
  readerFactory?: CountryReaderFactory;
  onError?: (error: Error) => void;
  scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  extractor?: CountryDatabaseArchiveExtractor;
}>;

export type CountryDatabaseManagerResult = Readonly<{
  status: "disabled" | "ready" | "failed" | "stopped";
  buildEpoch?: Date;
}>;

type DownloadRequest = {
  method: "GET" | "HEAD";
  accountId: string;
  licenseKey: string;
};

type ActiveDatabase = {
  buildEpoch: Date;
  filePath: string;
  lookup: (ipAddress: string) => string | null;
};

type CountryDatabaseManager = ReturnType<typeof createCountryDatabaseManager>;

export type CountryDatabaseLifecycle = Readonly<{
  initialize(): Promise<CountryDatabaseManagerResult>;
  isEnabled(): boolean;
  isReady(): boolean;
  lookup(ipAddress: string): Promise<string | null>;
  stop(): Promise<CountryDatabaseManagerResult>;
}>;

export type CountryDatabaseLifecycleOptions = Readonly<{
  createManager?: () => CountryDatabaseManager;
  managerOptions?: CountryDatabaseManagerOptions;
  readConfig?: () => GeoLiteCountryConfig;
}>;

const PROCESS_LIFECYCLE_KEY = "__noticeproGeoLiteCountryLifecycle__";

const defaultFileSystem: FileSystem = {
  mkdtemp: fsMkdtemp,
  readFile: fsReadFile,
  rename: fsRename,
  rm: fsRm,
  writeFile: fsWriteFile,
};

export function getGeoLiteCountryRuntimeConfig(
  env: RuntimeEnvironment = process.env,
): GeoLiteCountryConfig {
  return {
    enabled: env.NOTICEPRO_GEOIP_ENABLED === "true",
    accountId: env.MAXMIND_ACCOUNT_ID,
    licenseKey: env.MAXMIND_LICENSE_KEY,
  };
}

function normalizeEnabledConfig(
  value: GeoLiteCountryConfig,
): { enabled: true; accountId: string; licenseKey: string } | null {
  const accountId = value.accountId?.trim();
  const licenseKey = value.licenseKey?.trim();

  if (
    value.enabled !== true ||
    !accountId ||
    !/^[0-9]{1,20}$/.test(accountId) ||
    !licenseKey ||
    licenseKey.length > 256 ||
    !/^[\x21-\x7e]+$/.test(licenseKey)
  ) {
    return null;
  }

  return { enabled: true, accountId, licenseKey };
}

export function createCountryLookup(
  reader: Pick<CountryDatabaseRecord, "get">,
): (ipAddress: string) => string | null {
  return (ipAddress) => {
    if (typeof ipAddress !== "string" || !isPublicIpAddress(ipAddress)) {
      return null;
    }

    const isoCode = reader.get(ipAddress)?.country?.iso_code;

    return typeof isoCode === "string" && SUPPORTED_COUNTRY_CODES.has(isoCode)
      ? isoCode
      : null;
  };
}

export function createCountryDatabaseManager(
  options: CountryDatabaseManagerOptions = {},
) {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const now = options.now ?? Date.now;
  const readerFactory = options.readerFactory ?? openGeoLiteCountryReader;
  const extractor = options.extractor ?? extractCountryDatabase;
  const scheduleTimer =
    options.scheduleTimer ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    });
  const clearTimer = options.clearTimer ?? clearTimeout;
  const onError =
    options.onError ??
    ((error: Error) => {
      console.error(error.message);
    });
  const operationTimeoutMs =
    options.operationTimeoutMs ?? TOTAL_OPERATION_TIMEOUT_MS;

  let config: { accountId: string; licenseKey: string } | null = null;
  let activeDatabase: ActiveDatabase | null = null;
  let latestReleaseAt: number | null = null;
  let freshnessVerifiedAt: number | null = null;
  let freshnessKnown = false;
  let started = false;
  let stopped = false;
  let failureCount = 0;
  let operationSequence = 0;
  let privateDirectory: string | null = null;
  let expiredDatabasePath: string | null = null;
  let expiredDatabaseCleanup: Promise<void> | null = null;
  let scheduledTimer: TimerHandle | null = null;
  let inFlight: Promise<CountryDatabaseManagerResult> | null = null;
  let operationController: AbortController | null = null;

  function getResult(
    status: CountryDatabaseManagerResult["status"],
  ): CountryDatabaseManagerResult {
    return {
      status,
      ...(activeDatabase ? { buildEpoch: activeDatabase.buildEpoch } : {}),
    };
  }

  function cleanupExpiredDatabase(): Promise<void> {
    if (!expiredDatabasePath) return Promise.resolve();
    if (expiredDatabaseCleanup) return expiredDatabaseCleanup;

    const path = expiredDatabasePath;
    const cleanup = fileSystem
      .rm(path, { force: true })
      .then(() => {
        if (expiredDatabasePath === path) expiredDatabasePath = null;
      })
      .catch(() => {
        onError(getSafeUpdateError("cleanup"));
      })
      .finally(() => {
        if (expiredDatabaseCleanup === cleanup) expiredDatabaseCleanup = null;
      });
    expiredDatabaseCleanup = cleanup;
    return cleanup;
  }

  function expireDatabaseIfDue() {
    if (!activeDatabase || latestReleaseAt === null) return;

    const activeDay = utcDay(activeDatabase.buildEpoch.getTime());
    const latestDay = utcDay(latestReleaseAt);
    const cleanupAt =
      latestReleaseAt +
      MAXMIND_DATABASE_RETENTION_MS -
      DATABASE_EXPIRY_SAFETY_MARGIN_MS;
    if (activeDay >= latestDay || now() < cleanupAt) return;

    expiredDatabasePath = activeDatabase.filePath;
    activeDatabase = null;
    void cleanupExpiredDatabase();
  }

  function cancelScheduledTimer() {
    if (scheduledTimer === null) return;
    clearTimer(scheduledTimer);
    scheduledTimer = null;
  }

  function scheduleNext(delayMs: number) {
    cancelScheduledTimer();
    if (!started || stopped) return;

    let nextDelay = delayMs;
    if (activeDatabase && latestReleaseAt !== null) {
      const activeDay = utcDay(activeDatabase.buildEpoch.getTime());
      const latestDay = utcDay(latestReleaseAt);
      if (activeDay < latestDay) {
        const cleanupAt =
          latestReleaseAt +
          MAXMIND_DATABASE_RETENTION_MS -
          DATABASE_EXPIRY_SAFETY_MARGIN_MS;
        nextDelay = Math.min(nextDelay, Math.max(0, cleanupAt - now()));
      }
    }

    scheduledTimer = scheduleTimer(() => {
      scheduledTimer = null;
      expireDatabaseIfDue();
      void refresh();
    }, nextDelay);
  }

  async function sendRequest({
    method,
    accountId,
    licenseKey,
  }: DownloadRequest, operationSignal: AbortSignal): Promise<Response> {
    let url = new URL(DOWNLOAD_URL);
    let headers: HeadersInit = {
      Authorization: `Basic ${Buffer.from(
        `${accountId}:${licenseKey}`,
      ).toString("base64")}`,
    };

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const requestSignal = AbortSignal.any([
        operationSignal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      const response = await awaitWithSignal(
        Promise.resolve().then(() =>
          fetcher(url, {
            method,
            headers,
            redirect: "manual",
            signal: requestSignal,
          }),
        ),
        requestSignal,
      );

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (redirects === MAX_REDIRECTS) {
          throw new Error("Too many download redirects.");
        }

        const location = response.headers.get("location");
        if (!location) throw new Error("Missing download redirect location.");

        const redirectUrl = new URL(location, url);
        if (
          redirectUrl.protocol !== "https:" ||
          redirectUrl.hostname !== REDIRECT_HOST ||
          redirectUrl.username ||
          redirectUrl.password ||
          (redirectUrl.port !== "" && redirectUrl.port !== "443")
        ) {
          throw new Error("Unexpected download redirect.");
        }

        url = redirectUrl;
        headers = {};
        continue;
      }

      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Download returned HTTP ${response.status}.`);
      }

      return response;
    }

    throw new Error("Too many download redirects.");
  }

  async function readBoundedBody(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
        throw new Error("Download size is invalid or exceeds its limit.");
      }
    }

    if (!response.body) throw new Error("Download body is empty.");

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      let nextChunk = await awaitWithSignal(reader.read(), signal);
      while (!nextChunk.done) {
        const { value } = nextChunk;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new Error("Download exceeds its size limit.");
        }
        chunks.push(Buffer.from(value));
        nextChunk = await awaitWithSignal(reader.read(), signal);
      }
    } finally {
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
      } else {
        reader.releaseLock();
      }
    }

    if (totalBytes === 0) throw new Error("Download body is empty.");
    return Buffer.concat(chunks, totalBytes);
  }

  async function checkLatestBuildDate(signal: AbortSignal): Promise<number> {
    if (!config) throw new Error("Missing GeoLite credentials.");

    const response = await sendRequest({
      method: "HEAD",
      accountId: config.accountId,
      licenseKey: config.licenseKey,
    }, signal);
    const lastModified = response.headers.get("last-modified");
    const releaseAt = lastModified ? Date.parse(lastModified) : Number.NaN;

    if (
      !Number.isFinite(releaseAt) ||
      releaseAt <= 0 ||
      releaseAt > now() + 5 * 60_000
    ) {
      throw new Error("Invalid database build date.");
    }

    return releaseAt;
  }

  async function downloadArchive(signal: AbortSignal): Promise<Buffer> {
    if (!config) throw new Error("Missing GeoLite credentials.");

    const response = await sendRequest({
      method: "GET",
      accountId: config.accountId,
      licenseKey: config.licenseKey,
    }, signal);

    return readBoundedBody(response, MAX_COMPRESSED_BYTES, signal);
  }

  async function performRefresh(
    signal: AbortSignal,
  ): Promise<CountryDatabaseManagerResult> {
    const temporaryPaths: string[] = [];
    let failureStage: "refresh" | "cleanup" = "refresh";
    let headVerified = false;

    try {
      const releaseAt = await checkLatestBuildDate(signal);
      headVerified = true;
      latestReleaseAt = releaseAt;
      freshnessVerifiedAt = now();
      freshnessKnown = true;

      if (stopped) return getResult("stopped");
      throwIfAborted(signal);

      if (activeDatabase) {
        const activeDay = utcDay(activeDatabase.buildEpoch.getTime());
        const latestDay = utcDay(releaseAt);

        if (activeDay > latestDay) {
          freshnessKnown = false;
          throw new Error("Database build is newer than the provider release.");
        }
        if (activeDay === latestDay) {
          failureCount = 0;
          scheduleNext(UPDATE_INTERVAL_MS);
          return getResult("ready");
        }
        expireDatabaseIfDue();
        if (signal.aborted) throwIfAborted(signal);
      }

      await cleanupExpiredDatabase();
      throwIfAborted(signal);
      const directory = await getPrivateDirectory();
      if (stopped) return getResult("stopped");
      throwIfAborted(signal);

      operationSequence += 1;
      const suffix = operationSequence.toString(36);
      const archivePath = join(directory, `download-${suffix}.tar.gz`);
      const stagedDatabasePath = join(
        directory,
        `database-${suffix}.mmdb.part`,
      );
      const publishedDatabasePath = join(directory, "GeoLite2-Country.mmdb");
      temporaryPaths.push(archivePath, stagedDatabasePath);

      const archive = await downloadArchive(signal);
      await fileSystem.writeFile(archivePath, archive, {
        flag: "wx",
        mode: 0o600,
      });
      throwIfAborted(signal);
      const savedArchive = await fileSystem.readFile(archivePath);
      throwIfAborted(signal);
      const databaseBytes = await awaitWithSignal(
        extractor(savedArchive, signal),
        signal,
      );

      await fileSystem.writeFile(stagedDatabasePath, databaseBytes, {
        flag: "wx",
        mode: 0o600,
      });
      throwIfAborted(signal);
      const savedDatabase = await fileSystem.readFile(stagedDatabasePath);
      throwIfAborted(signal);
      const reader = readerFactory(savedDatabase);
      validateGeoLiteReader(reader);

      if (utcDay(reader.metadata.buildEpoch.getTime()) !== utcDay(releaseAt)) {
        throw new Error(
          "Downloaded database build does not match the provider.",
        );
      }
      throwIfAborted(signal);
      if (stopped) return getResult("stopped");

      await cleanupExpiredDatabase();
      throwIfAborted(signal);
      await fileSystem.rename(stagedDatabasePath, publishedDatabasePath);
      throwIfAborted(signal);
      activeDatabase = {
        buildEpoch: reader.metadata.buildEpoch,
        filePath: publishedDatabasePath,
        lookup: createCountryLookup(reader),
      };
      expiredDatabasePath = null;
      for (const temporaryPath of temporaryPaths) {
        await fileSystem.rm(temporaryPath, { force: true });
      }
      failureCount = 0;
      scheduleNext(UPDATE_INTERVAL_MS);
      return getResult("ready");
    } catch {
      if (!headVerified) freshnessKnown = false;
      failureStage = "refresh";
    }

    for (const temporaryPath of temporaryPaths) {
      try {
        await fileSystem.rm(temporaryPath, { force: true });
      } catch {
        failureStage = "cleanup";
      }
    }

    if (stopped) return getResult("stopped");

    failureCount += 1;
    const retryDelay = RETRY_DELAYS_MS[failureCount - 1] ?? UPDATE_INTERVAL_MS;
    scheduleNext(retryDelay);
    onError(getSafeUpdateError(failureStage));
    return getResult("failed");
  }

  function refresh(): Promise<CountryDatabaseManagerResult> {
    if (stopped) return Promise.resolve(getResult("stopped"));
    if (!started || !config) return Promise.resolve(getResult("disabled"));
    if (inFlight) return inFlight;

    cancelScheduledTimer();
    const controller = new AbortController();
    operationController = controller;
    const operationTimer = setTimeout(
      () => controller.abort(new Error("GeoLite update deadline exceeded.")),
      operationTimeoutMs,
    );
    const operation = performRefresh(controller.signal);
    const trackedOperation = operation.finally(() => {
      clearTimeout(operationTimer);
      if (operationController === controller) operationController = null;
      if (inFlight === trackedOperation) inFlight = null;
    });
    inFlight = trackedOperation;
    return trackedOperation;
  }

  async function getPrivateDirectory(): Promise<string> {
    if (privateDirectory !== null) return privateDirectory;

    const directory = await fileSystem.mkdtemp(
      join(tmpdir(), "noticepro-geolite2-country-"),
    );
    privateDirectory = directory;
    return directory;
  }

  return {
    start(
      nextConfig: GeoLiteCountryConfig = getGeoLiteCountryRuntimeConfig(),
    ): Promise<CountryDatabaseManagerResult> {
      if (stopped) return Promise.resolve(getResult("stopped"));

      const normalizedConfig = normalizeEnabledConfig(nextConfig);
      if (!normalizedConfig) return Promise.resolve(getResult("disabled"));

      if (inFlight) return inFlight;
      if (started) {
        return Promise.resolve(
          getResult(activeDatabase && freshnessKnown ? "ready" : "failed"),
        );
      }

      config = normalizedConfig;
      started = true;
      return refresh();
    },

    refresh,

    isReady(): boolean {
      expireDatabaseIfDue();
      return (
        !stopped &&
        freshnessKnown &&
        activeDatabase !== null &&
        latestReleaseAt !== null &&
        freshnessVerifiedAt !== null &&
        now() - freshnessVerifiedAt <= FRESHNESS_CHECK_MAX_AGE_MS
      );
    },

    lookup(ipAddress: string): Promise<string | null> {
      expireDatabaseIfDue();
      if (expiredDatabasePath) {
        return cleanupExpiredDatabase().then(() => null);
      }
      if (
        stopped ||
        !freshnessKnown ||
        !activeDatabase ||
        latestReleaseAt === null ||
        freshnessVerifiedAt === null ||
        now() - freshnessVerifiedAt > FRESHNESS_CHECK_MAX_AGE_MS
      ) {
        return Promise.resolve(null);
      }

      return Promise.resolve(activeDatabase.lookup(ipAddress));
    },

    async stop(): Promise<CountryDatabaseManagerResult> {
      stopped = true;
      cancelScheduledTimer();
      operationController?.abort(new Error("GeoLite update stopped."));

      const pendingOperation = inFlight;
      try {
        await pendingOperation;
      } finally {
        await cleanupExpiredDatabase();
        activeDatabase = null;
        config = null;
        freshnessKnown = false;
        latestReleaseAt = null;
        freshnessVerifiedAt = null;

        if (privateDirectory !== null) {
          await fileSystem.rm(privateDirectory, {
            force: true,
            recursive: true,
          });
          privateDirectory = null;
        }
      }

      return getResult("stopped");
    },
  };
}

export function createCountryDatabaseLifecycle(
  options: CountryDatabaseLifecycleOptions = {},
): CountryDatabaseLifecycle {
  let manager: CountryDatabaseManager | null = null;
  let initialization: Promise<CountryDatabaseManagerResult> | null = null;
  let shutdown: Promise<CountryDatabaseManagerResult> | null = null;
  let enabled = false;
  let stopped = false;

  return {
    initialize(): Promise<CountryDatabaseManagerResult> {
      if (initialization) return initialization;
      if (stopped) return Promise.resolve({ status: "stopped" });

      const config = (options.readConfig ?? getGeoLiteCountryRuntimeConfig)();
      const normalizedConfig = normalizeEnabledConfig(config);
      if (!normalizedConfig) {
        initialization = Promise.resolve({ status: "disabled" });
        return initialization;
      }

      enabled = true;
      manager =
        options.createManager?.() ??
        createCountryDatabaseManager(options.managerOptions);
      initialization = manager.start(normalizedConfig);
      return initialization;
    },

    isEnabled(): boolean {
      return enabled && !stopped;
    },

    isReady(): boolean {
      return !stopped && manager?.isReady() === true;
    },

    lookup(ipAddress: string): Promise<string | null> {
      if (stopped || !manager) return Promise.resolve(null);
      return manager.lookup(ipAddress);
    },

    stop(): Promise<CountryDatabaseManagerResult> {
      if (shutdown) return shutdown;
      stopped = true;
      shutdown = manager
        ? manager.stop()
        : Promise.resolve({ status: "stopped" });
      return shutdown;
    },
  };
}

type GlobalWithCountryDatabaseLifecycle = typeof globalThis & {
  __noticeproGeoLiteCountryLifecycle__?: CountryDatabaseLifecycle;
};

function getProcessCountryDatabaseLifecycle(): CountryDatabaseLifecycle {
  const globalState = globalThis as GlobalWithCountryDatabaseLifecycle;
  globalState[PROCESS_LIFECYCLE_KEY] ??= createCountryDatabaseLifecycle();
  return globalState[PROCESS_LIFECYCLE_KEY];
}

getProcessCountryDatabaseLifecycle();

export function isCountryDatabaseReady(): boolean {
  return getProcessCountryDatabaseLifecycle().isReady();
}

function openGeoLiteCountryReader(database: Buffer): CountryDatabaseRecord {
  const reader = new Reader<CountryResponse>(database);
  validateGeoLiteReader(reader);
  return reader;
}

function validateGeoLiteReader(
  reader: CountryDatabaseRecord,
): asserts reader is CountryDatabaseRecord {
  if (
    reader.metadata.databaseType !== DATABASE_TYPE ||
    !(reader.metadata.buildEpoch instanceof Date) ||
    !Number.isFinite(reader.metadata.buildEpoch.getTime()) ||
    typeof reader.get !== "function"
  ) {
    throw new Error("The database is not a valid GeoLite2 Country database.");
  }
}

function getSafeUpdateError(stage: "refresh" | "cleanup"): Error {
  return new Error(
    stage === "cleanup"
      ? "NoticePro GeoLite country database cleanup failed."
      : "NoticePro GeoLite country database update failed.",
  );
}

function utcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function extractCountryDatabase(
  compressedArchive: Buffer,
  signal: AbortSignal,
): Promise<Buffer> {
  const tarArchive = await gunzipBounded(compressedArchive, signal);
  throwIfAborted(signal);
  let offset = 0;
  let rootDirectory: string | null = null;
  let database: Buffer | null = null;
  const seenEntries = new Set<string>();
  let terminated = false;

  while (offset + TARBLOCK_BYTES <= tarArchive.length) {
    throwIfAborted(signal);
    const header = tarArchive.subarray(offset, offset + TARBLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      const trailing = tarArchive.subarray(offset);
      if (
        trailing.length < TARBLOCK_BYTES * 2 ||
        !trailing.every((byte) => byte === 0)
      ) {
        throw new Error("The database archive has an invalid terminator.");
      }
      terminated = true;
      break;
    }

    validateTarHeader(header);
    const name = readTarPath(header);
    const type = header[156];
    const size = readTarOctal(header.subarray(124, 136));
    const dataStart = offset + TARBLOCK_BYTES;
    const dataEnd = dataStart + size;
    const nextOffset =
      dataStart + Math.ceil(size / TARBLOCK_BYTES) * TARBLOCK_BYTES;

    if (dataEnd > tarArchive.length || nextOffset > tarArchive.length) {
      throw new Error("The database archive is truncated.");
    }
    if (seenEntries.has(name)) {
      throw new Error("The database archive contains duplicate entries.");
    }
    seenEntries.add(name);

    if (type === 53) {
      const directoryName = name.endsWith("/") ? name.slice(0, -1) : name;
      if (
        size !== 0 ||
        directoryName.includes("/") ||
        !/^GeoLite2-Country_[0-9]{8}$/.test(directoryName) ||
        (rootDirectory !== null && rootDirectory !== directoryName)
      ) {
        throw new Error(
          "The database archive contains an unexpected directory.",
        );
      }
      rootDirectory = directoryName;
    } else if (type === 0 || type === 48) {
      if (!rootDirectory) {
        throw new Error("The database archive is missing its root directory.");
      }
      if (name === `${rootDirectory}/GeoLite2-Country.mmdb`) {
        if (database !== null || size === 0 || size > MAX_DATABASE_BYTES) {
          throw new Error("The country database is empty or too large.");
        }
        database = tarArchive.subarray(dataStart, dataEnd);
      } else if (
        name !== `${rootDirectory}/COPYRIGHT.txt` &&
        name !== `${rootDirectory}/LICENSE.txt`
      ) {
        throw new Error("The database archive contains an unexpected file.");
      }
    } else {
      throw new Error(
        "The database archive contains a link or unsupported entry.",
      );
    }

    offset = nextOffset;
  }

  if (!terminated || rootDirectory === null || database === null) {
    throw new Error("The database archive is incomplete.");
  }

  return Buffer.from(database);
}

function gunzipBounded(
  compressedArchive: Buffer,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      gunzip.destroy();
      reject(error);
    };
    const onAbort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("GeoLite update was aborted."),
      );

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    gunzip.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        fail(new Error("The database archive exceeds its size limit."));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.once("error", () =>
      fail(new Error("The database archive is malformed or too large.")),
    );
    gunzip.once("end", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    });
    gunzip.end(compressedArchive);
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("GeoLite update was aborted.");
}

function awaitWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("GeoLite update was aborted."),
    );
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("GeoLite update was aborted."),
      );
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function validateTarHeader(header: Buffer) {
  const magic = header.toString("ascii", 257, 263);
  if (magic !== "ustar\u0000" && magic !== "ustar ") {
    throw new Error("The database archive has an unsupported tar header.");
  }

  const expectedChecksum = readTarOctal(header.subarray(148, 156));
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (checksum !== expectedChecksum) {
    throw new Error("The database archive has an invalid tar checksum.");
  }
}

function readTarPath(header: Buffer): string {
  const name = readTarString(header.subarray(0, 100));
  const prefix = readTarString(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  const parts = path.split("/");
  const safeParts = path.endsWith("/") ? parts.slice(0, -1) : parts;

  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    safeParts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("The database archive contains an unsafe path.");
  }

  return path;
}

function readTarString(value: Buffer): string {
  const end = value.indexOf(0);
  const bytes = end === -1 ? value : value.subarray(0, end);
  if (bytes.some((byte) => byte > 0x7f)) {
    throw new Error("The database archive contains a non-ASCII path.");
  }
  return bytes.toString("ascii");
}

function readTarOctal(value: Buffer): number {
  const end = value.indexOf(0);
  const field = (end === -1 ? value : value.subarray(0, end))
    .toString("ascii")
    .trim();

  if (!field) return 0;
  if (!/^[0-7]+$/.test(field)) {
    throw new Error("The database archive has an invalid numeric field.");
  }

  const result = Number.parseInt(field, 8);
  if (!Number.isSafeInteger(result)) {
    throw new Error("The database archive has an oversized entry.");
  }
  return result;
}

function isPublicIpAddress(ipAddress: string): boolean {
  const family = isIP(ipAddress);
  if (family === 4) return isPublicIpv4(ipAddress);
  if (family === 6) return isPublicIpv6(ipAddress);
  return false;
}

function isPublicIpv4(ipAddress: string): boolean {
  const octets = ipAddress.split(".").map(Number);
  const address = octets.reduce((value, octet) => value * 256 + octet, 0);
  const blockedRanges: readonly [number, number][] = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];

  return !blockedRanges.some(([network, prefix]) => {
    const rangeSize = 2 ** (32 - prefix);
    return Math.floor(address / rangeSize) === Math.floor(network / rangeSize);
  });
}

function isPublicIpv6(ipAddress: string): boolean {
  const firstHextetText = ipAddress.split(":").find((part) => part !== "");
  const firstHextet = Number.parseInt(firstHextetText ?? "0", 16);

  if (firstHextet < 0x2000 || firstHextet > 0x3fff) return false;

  const groups = expandIpv6(ipAddress);
  if (!groups) return false;

  const firstTwoHextets = groups.slice(0, 2);
  const [first, second] = firstTwoHextets;

  if (
    (first === 0x2001 && second <= 0x01ff) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002 ||
    (first === 0x3fff && (second & 0xf000) === 0)
  ) {
    return false;
  }

  return true;
}

function expandIpv6(ipAddress: string): number[] | null {
  const address = ipAddress.toLowerCase();
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(":");
    const result: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const octets = part.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => octet < 0 || octet > 255)
        ) {
          return null;
        }
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        result.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return result;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;

  const missingGroups = 8 - left.length - right.length;
  if (missingGroups < 1) return null;
  return [...left, ...Array.from({ length: missingGroups }, () => 0), ...right];
}

export async function lookupCountryForIp(
  ipAddress: string,
): Promise<string | null> {
  return getProcessCountryDatabaseLifecycle().lookup(ipAddress);
}
