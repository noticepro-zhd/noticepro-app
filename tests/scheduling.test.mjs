import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function compile(relativePath) {
  const source = fs.readFileSync(
    new URL(relativePath, import.meta.url),
    "utf8",
  );

  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
}

function moduleUrl(code) {
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
}

const sharedUrl = moduleUrl(
  compile("../app/features/widgets/scheduling.shared.ts"),
);

const {
  parseScheduleInput,
  parseScheduleInputPreservingInstant,
  toScheduleInput,
  formatSchedule,
  isValidScheduleTimeZone,
} = await import(sharedUrl);

const serverCode = compile(
  "../app/features/widgets/scheduling.server.ts",
).replace(/(["'])\.\/scheduling\.shared\1/g, JSON.stringify(sharedUrl));

const { getShopScheduleTimeZone } = await import(moduleUrl(serverCode));

function expectInstant(input, zone, expected) {
  const result = parseScheduleInput(input, zone);
  assert.equal(result.ok, true);
  assert.equal(result.date?.toISOString(), expected);
}

const conversionCases = [
  ["Dhaka", "2026-11-25T23:30", "Asia/Dhaka", "2026-11-25T17:30:00.000Z"],
  [
    "New York winter",
    "2026-11-25T12:00",
    "America/New_York",
    "2026-11-25T17:00:00.000Z",
  ],
  [
    "New York summer",
    "2026-07-01T12:00",
    "America/New_York",
    "2026-07-01T16:00:00.000Z",
  ],
  [
    "Kathmandu quarter-hour offset",
    "2026-11-25T12:00",
    "Asia/Kathmandu",
    "2026-11-25T06:15:00.000Z",
  ],
  [
    "UTC with seconds",
    "2026-11-25T12:34:56",
    "UTC",
    "2026-11-25T12:34:56.000Z",
  ],
];

for (const [name, input, zone, expected] of conversionCases) {
  test(`local input converts correctly: ${name}`, () => {
    expectInstant(input, zone, expected);
  });
}

test("saved UTC instant displays in the requested zone", () => {
  assert.equal(
    toScheduleInput("2026-11-25T17:30:42Z", "Asia/Dhaka"),
    "2026-11-25T23:30:42",
  );
});

test("display includes the explicit timezone", () => {
  assert.equal(
    formatSchedule("2026-11-25T17:30:00Z", "Asia/Dhaka"),
    "2026-11-25 23:30:00 (Asia/Dhaka)",
  );
});

test("empty optional schedule remains null", () => {
  assert.deepEqual(parseScheduleInput("", "Asia/Dhaka"), {
    ok: true,
    date: null,
  });
  assert.equal(toScheduleInput(null, "Asia/Dhaka"), "");
});

test("invalid timezone is rejected, not treated as UTC", () => {
  assert.equal(isValidScheduleTimeZone("Invalid/Zone"), false);
  assert.equal(
    parseScheduleInput("2026-11-25T12:00", "Invalid/Zone").ok,
    false,
  );
});

for (const input of [
  "2026-02-30T12:00",
  "2026-13-01T12:00",
  "2026-11-25T24:00",
  "2026-11-25T12:60",
  "2026-11-25T12:00:60",
  "2026-11-25T12:00Z",
  "not-a-date",
]) {
  test(`invalid local input is rejected: ${input}`, () => {
    assert.equal(parseScheduleInput(input, "UTC").ok, false);
  });
}

test("DST missing local time is rejected", () => {
  assert.equal(
    parseScheduleInput("2026-03-08T02:30", "America/New_York").ok,
    false,
  );
});

test("new DST repeated local time is rejected", () => {
  assert.equal(
    parseScheduleInput("2026-11-01T01:30", "America/New_York").ok,
    false,
  );
});

test("unchanged edit preserves milliseconds", () => {
  const original = "2026-11-25T17:30:42.987Z";

  const result = parseScheduleInputPreservingInstant(
    toScheduleInput(original, "Asia/Dhaka"),
    "Asia/Dhaka",
    original,
  );

  assert.equal(result.ok, true);
  assert.equal(result.date?.toISOString(), original);
});

test("browser-omitted zero seconds preserve the original instant", () => {
  const original = "2026-11-25T17:30:00.123Z";

  const result = parseScheduleInputPreservingInstant(
    "2026-11-25T23:30",
    "Asia/Dhaka",
    original,
  );

  assert.equal(result.ok, true);
  assert.equal(result.date?.toISOString(), original);
});

for (const original of [
  "2026-11-01T05:30:00.123Z",
  "2026-11-01T06:30:00.456Z",
]) {
  test(`unchanged DST overlap retains exact instant: ${original}`, () => {
    const result = parseScheduleInputPreservingInstant(
      "2026-11-01T01:30",
      "America/New_York",
      original,
    );

    assert.equal(result.ok, true);
    assert.equal(result.date?.toISOString(), original);
  });
}

test("changed input is converted rather than retaining old time", () => {
  const result = parseScheduleInputPreservingInstant(
    "2026-11-25T23:45",
    "Asia/Dhaka",
    "2026-11-25T17:30:00.123Z",
  );

  assert.equal(result.ok, true);
  assert.equal(result.date?.toISOString(), "2026-11-25T17:45:00.000Z");
});

test("optional existing schedule can be cleared", () => {
  assert.deepEqual(
    parseScheduleInputPreservingInstant(
      "",
      "Asia/Dhaka",
      "2026-11-25T17:30:00Z",
    ),
    { ok: true, date: null },
  );
});

function mockAdmin(body, ok = true) {
  return {
    graphql: async (query) => {
      assert.match(query, /ianaTimezone/);

      return {
        ok,
        json: async () => body,
      };
    },
  };
}

test("server returns the authenticated shop timezone", async () => {
  const result = await getShopScheduleTimeZone(
    mockAdmin({
      data: { shop: { ianaTimezone: "America/New_York" } },
    }),
  );

  assert.equal(result, "America/New_York");
});

test("server rejects HTTP failure", async () => {
  assert.equal(await getShopScheduleTimeZone(mockAdmin({}, false)), null);
});

test("server rejects GraphQL errors", async () => {
  assert.equal(
    await getShopScheduleTimeZone(
      mockAdmin({
        errors: [{ message: "Test failure" }],
        data: { shop: { ianaTimezone: "Asia/Dhaka" } },
      }),
    ),
    null,
  );
});

test("server rejects missing or invalid timezone data", async () => {
  for (const body of [
    null,
    {},
    { data: null },
    { data: { shop: null } },
    { data: { shop: { ianaTimezone: "Invalid/Zone" } } },
    { data: { shop: { ianaTimezone: 123 } } },
  ]) {
    assert.equal(await getShopScheduleTimeZone(mockAdmin(body)), null);
  }
});

test("server handles a lookup exception without fallback", async () => {
  const result = await getShopScheduleTimeZone({
    graphql: async () => {
      throw new Error("Synthetic lookup failure");
    },
  });

  assert.equal(result, null);
});
