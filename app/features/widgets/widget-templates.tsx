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
};

export function useWidgetTemplates(
  resetKey: string,
  solution: WidgetTemplateSolution,
) {
  const freshState: TemplateState = {
    resetKey,
    revision: 0,
    template: null,
  };

  const [state, setState] = useState<TemplateState>(freshState);

  // Reset only when editor identity changes, not on validation errors
  // or ordinary loader revalidation.
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
    }));

    return selected;
  }

  return {
    template: current.template,
    templateKey: `${resetKey}:${current.revision}`,
    applyTemplate,
  };
}

type WidgetTemplatePickerProps = {
  solution: WidgetTemplateSolution;
  onApply: (id: string) => void;
};

export function WidgetTemplatePicker({
  solution,
  onApply,
}: WidgetTemplatePickerProps) {
  const [selectedId, setSelectedId] = useState("");
  const selected = getWidgetTemplate(solution, selectedId);

  return (
    <div
      style={{
        padding: "12px",
        border: "1px solid #d1d5db",
        borderRadius: "8px",
      }}
    >
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
