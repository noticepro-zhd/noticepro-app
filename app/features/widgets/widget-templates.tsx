import { useState } from "react";
import {
  getWidgetTemplate,
  WIDGET_TEMPLATES,
  type WidgetTemplate,
  type WidgetTemplateSolution,
} from "./templates.shared";

type TemplateState = {
  resetKey: string;
  revision: number;
  template: WidgetTemplate | null;
  sourceTemplateId: string | null;
};

export function useWidgetTemplates(
  resetKey: string,
  solution: WidgetTemplateSolution,
  initialSourceTemplateId?: string | null,
) {
  const savedTemplate = getWidgetTemplate(
    solution,
    initialSourceTemplateId ?? "",
  );

  const freshState: TemplateState = {
    resetKey,
    revision: 0,
    // Restoring identity must not overwrite saved/customized values.
    template: null,
    sourceTemplateId: savedTemplate?.id ?? null,
  };

  const [state, setState] = useState<TemplateState>(freshState);
  const current = state.resetKey === resetKey ? state : freshState;

  if (state.resetKey !== resetKey) {
    setState(freshState);
  }

  function applyTemplate(id: string): WidgetTemplate | null {
    const selected = getWidgetTemplate(solution, id);
    if (!selected) return null;

    setState((previous) => ({
      resetKey,
      revision: previous.resetKey === resetKey ? previous.revision + 1 : 1,
      template: selected,
      sourceTemplateId: selected.id,
    }));

    return selected;
  }

  return {
    template: current.template,
    templateKey: `${resetKey}:${current.revision}`,
    sourceTemplateId: current.sourceTemplateId,
    applyTemplate,
  };
}

type WidgetTemplatePickerProps = {
  solution: WidgetTemplateSolution;
  sourceTemplateId?: string | null;
  onApply: (id: string) => void;
};

export function WidgetTemplatePicker({
  solution,
  sourceTemplateId,
  onApply,
}: WidgetTemplatePickerProps) {
  const [selectedId, setSelectedId] = useState(
    getWidgetTemplate(solution, sourceTemplateId ?? "")?.id ?? "",
  );

  const selected = getWidgetTemplate(solution, selectedId);

  return (
    <div
      style={{
        padding: "12px",
        border: "1px solid #d1d5db",
        borderRadius: "8px",
      }}
    >
      <input
        type="hidden"
        name="sourceTemplateId"
        value={sourceTemplateId ?? ""}
      />

      <label>
        Ready-made template
        <select
          value={selectedId}
          onChange={(event) => setSelectedId(event.currentTarget.value)}
          style={{
            display: "block",
            width: "100%",
            marginTop: "6px",
            padding: "10px",
            font: "inherit",
          }}
        >
          <option value="">Choose a template</option>
          {WIDGET_TEMPLATES[solution].map((template) => (
            <option key={template.id} value={template.id}>
              {template.label}
            </option>
          ))}
        </select>
      </label>

      {selected ? (
        <p
          style={{
            backgroundColor: selected.backgroundColor,
            color: selected.textColor,
            padding: "12px",
            borderRadius: "6px",
          }}
        >
          {selected.message}
        </p>
      ) : null}

      <button
        type="button"
        disabled={!selected}
        onClick={() => {
          if (selected) onApply(selected.id);
        }}
        style={{ marginTop: "8px" }}
      >
        Apply template
      </button>

      <p style={{ marginBottom: 0 }}>
        Replaces only the message and colors. Review the wording and edit as
        needed, then save. Other settings stay unchanged.
      </p>
    </div>
  );
}
