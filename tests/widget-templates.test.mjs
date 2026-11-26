import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as templates from "../app/features/widgets/templates.shared.ts";

const require = createRequire(import.meta.url);

const uiSource = fs.readFileSync(
  new URL("../app/features/widgets/widget-templates.tsx", import.meta.url),
  "utf8",
);

const compiledUi = ts.transpileModule(uiSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function loadTemplateUi(reactOverride) {
  const module = { exports: {} };

  const context = vm.createContext({
    module,
    exports: module.exports,
  });

  function requireModule(specifier) {
    if (specifier === "./templates.shared") return templates;

    if (specifier === "react") {
      return reactOverride ?? require("react");
    }

    if (specifier === "react/jsx-runtime") {
      return require(specifier);
    }

    throw new Error("Unexpected template import: " + specifier);
  }

  const execute = vm.runInContext(
    "(function(exports, require, module) {\n" + compiledUi + "\n})",
    context,
  );

  execute(module.exports, requireModule, module);
  return module.exports;
}

function makeHookHarness() {
  let initialized = false;
  let storedState;
  let changed = false;

  const react = {
    useState(initial) {
      if (!initialized) {
        storedState = initial;
        initialized = true;
      }

      return [
        storedState,
        (next) => {
          storedState = typeof next === "function" ? next(storedState) : next;
          changed = true;
        },
      ];
    },
  };

  const { useWidgetTemplates } = loadTemplateUi(react);

  return {
    render(
      resetKey,
      solution = "ANNOUNCEMENT",
      initialSourceTemplateId = null,
    ) {
      for (let attempt = 0; attempt < 5; attempt++) {
        changed = false;
        const result = useWidgetTemplates(
          resetKey,
          solution,
          initialSourceTemplateId,
        );

        if (!changed) return result;
      }

      throw new Error("Template state did not settle");
    },
  };
}

for (const solution of ["ANNOUNCEMENT", "NOTICE", "COUNTDOWN"]) {
  test(solution + " has three valid message/color-only presets", () => {
    const presets = templates.WIDGET_TEMPLATES[solution];

    assert.equal(presets.length, 3);
    assert.equal(new Set(presets.map((item) => item.id)).size, 3);

    for (const preset of presets) {
      assert.deepEqual(Object.keys(preset).sort(), [
        "backgroundColor",
        "id",
        "label",
        "message",
        "textColor",
      ]);

      assert.ok(preset.id.trim());
      assert.ok(preset.label.trim());
      assert.ok(preset.message.trim());

      assert.match(preset.backgroundColor, /^#[0-9a-f]{6}$/i);
      assert.match(preset.textColor, /^#[0-9a-f]{6}$/i);

      assert.equal(templates.getWidgetTemplate(solution, preset.id), preset);

      for (const otherSolution of ["ANNOUNCEMENT", "NOTICE", "COUNTDOWN"]) {
        if (otherSolution !== solution) {
          assert.equal(
            templates.getWidgetTemplate(otherSolution, preset.id),
            null,
          );
        }
      }
    }

    assert.equal(
      templates.getWidgetTemplate(solution, "unknown-template"),
      null,
    );
  });
}

test("selection starts empty and invalid IDs do not apply", () => {
  const harness = makeHookHarness();
  let result = harness.render("create");

  assert.equal(result.template, null);

  const originalKey = result.templateKey;
  assert.equal(result.applyTemplate("unknown-template"), null);

  result = harness.render("create");

  assert.equal(result.template, null);
  assert.equal(result.templateKey, originalKey);
});

test("Apply selects a preset and reapply remounts affected fields", () => {
  const harness = makeHookHarness();
  let result = harness.render("create");

  const originalKey = result.templateKey;
  result.applyTemplate("announcement-welcome");

  result = harness.render("create");

  assert.equal(result.template.id, "announcement-welcome");
  assert.notEqual(result.templateKey, originalKey);

  const firstApplyKey = result.templateKey;
  result.applyTemplate("announcement-welcome");

  result = harness.render("create");

  assert.equal(result.template.id, "announcement-welcome");
  assert.notEqual(result.templateKey, firstApplyKey);
});

test("same editor identity retains template state on revalidation", () => {
  const harness = makeHookHarness();
  let result = harness.render("edit-a");

  result.applyTemplate("announcement-new-arrivals");
  result = harness.render("edit-a");

  const appliedKey = result.templateKey;

  for (let repeat = 0; repeat < 3; repeat++) {
    result = harness.render("edit-a");

    assert.equal(result.template.id, "announcement-new-arrivals");
    assert.equal(result.templateKey, appliedKey);
  }
});

test("destination and successful-mutation resets do not revive old selections", () => {
  const harness = makeHookHarness();
  let result = harness.render("edit-a");

  result.applyTemplate("announcement-welcome");
  result = harness.render("edit-a");
  assert.ok(result.template);

  result = harness.render("edit-b");
  assert.equal(result.template, null);

  result = harness.render("edit-a");
  assert.equal(result.template, null);

  result.applyTemplate("announcement-featured");
  result = harness.render("edit-a:successful-update");
  assert.equal(result.template, null);
});

test("real picker renders choices and a non-submitting Apply button", () => {
  const { WidgetTemplatePicker } = loadTemplateUi();

  for (const solution of ["ANNOUNCEMENT", "NOTICE", "COUNTDOWN"]) {
    const html = renderToStaticMarkup(
      React.createElement(WidgetTemplatePicker, {
        solution,
        onApply() {
          throw new Error("Rendering must not apply a template");
        },
      }),
    );

    assert.match(html, /Choose a template/);
    assert.match(html, /<button[^>]*type="button"/);
    assert.match(html, /<button[^>]*disabled/);
    assert.doesNotMatch(html, /<form\b/);

    for (const preset of templates.WIDGET_TEMPLATES[solution]) {
      assert.ok(html.includes(preset.id));
      assert.ok(html.includes(preset.label));
    }
  }
});

test("routes remount only template fields and retain existing Form identity", () => {
  for (const [solution, expectedKeys] of [
    ["announcement", 3],
    ["notice", 2],
    ["countdown", 3],
  ]) {
    const source = fs.readFileSync(
      new URL("../app/routes/app." + solution + ".tsx", import.meta.url),
      "utf8",
    );

    assert.match(source, /<WidgetTemplatePicker\b/);

    assert.equal(
      (source.match(/key=\{templateKey\}/g) ?? []).length,
      expectedKeys,
      solution,
    );

    assert.doesNotMatch(source, /<Form\b[^>]*key=\{templateKey\}/, solution);

    assert.match(source, /template\?\.backgroundColor/);
    assert.match(source, /template\?\.textColor/);

    if (solution === "notice") {
      assert.match(source, /setMessage\(selected\.message\)/);
    } else {
      assert.match(source, /template\?\.message/);
      assert.match(source, /key=\{editorResetKey\}/);
    }
  }
});

test("template selection parser preserves legacy forms and validates solution IDs", () => {
  const missing = new FormData();

  assert.deepEqual(
    templates.readWidgetTemplateSelection(missing, "ANNOUNCEMENT"),
    { ok: true, data: {} },
  );

  for (const solution of ["ANNOUNCEMENT", "NOTICE", "COUNTDOWN"]) {
    const empty = new FormData();
    empty.set("sourceTemplateId", "");

    assert.deepEqual(templates.readWidgetTemplateSelection(empty, solution), {
      ok: true,
      data: { sourceTemplateId: null },
    });

    const preset = templates.WIDGET_TEMPLATES[solution][0];
    const valid = new FormData();
    valid.set("sourceTemplateId", preset.id);

    assert.deepEqual(templates.readWidgetTemplateSelection(valid, solution), {
      ok: true,
      data: { sourceTemplateId: preset.id },
    });

    const invalid = new FormData();
    invalid.set("sourceTemplateId", "unknown-template");

    assert.equal(
      templates.readWidgetTemplateSelection(invalid, solution).ok,
      false,
    );

    const otherSolution = solution === "NOTICE" ? "COUNTDOWN" : "NOTICE";

    invalid.set(
      "sourceTemplateId",
      templates.WIDGET_TEMPLATES[otherSolution][0].id,
    );

    assert.equal(
      templates.readWidgetTemplateSelection(invalid, solution).ok,
      false,
    );
  }
});

test("saved template identity restores without applying preset values", () => {
  const harness = makeHookHarness();

  let result = harness.render(
    "edit-saved",
    "ANNOUNCEMENT",
    "announcement-featured",
  );

  assert.equal(result.sourceTemplateId, "announcement-featured");
  assert.equal(result.template, null);

  const originalKey = result.templateKey;

  result = harness.render(
    "edit-saved",
    "ANNOUNCEMENT",
    "announcement-featured",
  );

  assert.equal(result.sourceTemplateId, "announcement-featured");
  assert.equal(result.template, null);
  assert.equal(result.templateKey, originalKey);

  result.applyTemplate("announcement-welcome");

  result = harness.render(
    "edit-saved",
    "ANNOUNCEMENT",
    "announcement-featured",
  );

  assert.equal(result.sourceTemplateId, "announcement-welcome");
  assert.equal(result.template.id, "announcement-welcome");
  assert.notEqual(result.templateKey, originalKey);
});

test("saved picker identity renders selected and is submitted separately", () => {
  const { WidgetTemplatePicker } = loadTemplateUi();

  const html = renderToStaticMarkup(
    React.createElement(WidgetTemplatePicker, {
      solution: "ANNOUNCEMENT",
      sourceTemplateId: "announcement-featured",
      onApply() {
        throw new Error("Restoring must not Apply");
      },
    }),
  );

  assert.match(html, /<option[^>]*value="announcement-featured"[^>]*selected/);

  assert.match(
    html,
    /<input[^>]*name="sourceTemplateId"[^>]*value="announcement-featured"/,
  );

  // Browsing another option must not submit the dropdown itself.
  assert.doesNotMatch(html, /<select[^>]*name=/);
});
