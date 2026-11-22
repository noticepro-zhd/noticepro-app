import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import type { TargetingMode, WidgetTargeting } from "./targeting.shared";

type SelectedResource = {
  id: string;
  title?: string;
};

type Props = {
  initialValue?: WidgetTargeting;
};

function selectedResources(
  ids: string[],
  resource: "Product" | "Collection",
): SelectedResource[] {
  const pattern = new RegExp(
    `^gid://shopify/${resource}/[1-9][0-9]*$`,
  );

  return [
    ...new Set(
      ids.filter((id) => typeof id === "string" && pattern.test(id)),
    ),
  ].slice(0, 50).map((id) => ({ id }));
}

export default function WidgetTargetingFields({ initialValue }: Props) {
  const shopify = useAppBridge();

  const [mode, setMode] = useState<TargetingMode>(
    initialValue?.targetingMode ?? "ALL",
  );

  const [products, setProducts] = useState<SelectedResource[]>(() =>
    selectedResources(initialValue?.targetProductIds ?? [], "Product"),
  );

  const [collections, setCollections] = useState<SelectedResource[]>(() =>
    selectedResources(initialValue?.targetCollectionIds ?? [], "Collection"),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isProducts = mode === "PRODUCTS";
  const selected = isProducts ? products : collections;
  const resourceLabel = isProducts ? "products" : "collections";

  async function chooseResources() {
    if (busy || mode === "ALL") return;

    setBusy(true);
    setError("");

    try {
      const result = await shopify.resourcePicker({
        type: isProducts ? "product" : "collection",
        action: "select",
        multiple: 50,
        selectionIds: selected.map(({ id }) => ({ id })),
        ...(isProducts ? { filter: { variants: false } } : {}),
      });

      // Cancel must preserve the existing selection.
      if (result === undefined) return;

      if (!Array.isArray(result)) {
        setError("The selector returned an invalid selection.");
        return;
      }

      if (result.length > 50) {
        setError("You can select up to 50 items.");
        return;
      }

      const pattern = isProducts
        ? /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/
        : /^gid:\/\/shopify\/Collection\/[1-9][0-9]*$/;

      const resources = [
        ...new Map(
          result
            .filter(
              (item): item is typeof item =>
                typeof item.id === "string" && pattern.test(item.id),
            )
            .map((item) => [
              item.id,
              { id: item.id, title: item.title },
            ]),
        ).values(),
      ].slice(0, 50);

      if (isProducts) {
        setProducts(resources);
      } else {
        setCollections(resources);
      }
    } catch {
      setError(
        "The selector could not be opened. Check app permissions and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function removeResource(id: string) {
    if (isProducts) {
      setProducts((items) => items.filter((item) => item.id !== id));
    } else {
      setCollections((items) => items.filter((item) => item.id !== id));
    }
  }

  return (
    <fieldset
      style={{
        display: "grid",
        gap: "12px",
        padding: "16px",
        border: "1px solid #d1d5db",
        borderRadius: "8px",
        minWidth: 0,
      }}
    >
      <legend>Display targeting</legend>

      <label>
        Show this widget on
        <select
          value={mode}
          disabled={busy}
          onChange={(event) => {
            const value = event.currentTarget.value;

            if (
              value === "ALL" ||
              value === "PRODUCTS" ||
              value === "COLLECTIONS"
            ) {
              setMode(value);
              setError("");
            }
          }}
          style={{
            display: "block",
            width: "100%",
            marginTop: "6px",
            padding: "10px",
          }}
        >
          <option value="ALL">All pages where the widget is placed</option>
          <option value="PRODUCTS">Selected product pages</option>
          <option value="COLLECTIONS">
            Selected collections and their product pages
          </option>
        </select>
      </label>
      <input type="hidden" name="targetingMode" value={mode} />
      <input
        type="hidden"
        name="targetProductIds"
        value={JSON.stringify(products.map(({ id }) => id))}
      />

      <input
        type="hidden"
        name="targetCollectionIds"
        value={JSON.stringify(collections.map(({ id }) => id))}
      />

      {mode !== "ALL" ? (
        <>
          <button type="button" onClick={chooseResources} disabled={busy}>
            {busy ? "Opening selector…" : `Select ${resourceLabel}`}
          </button>

          <p style={{ margin: 0 }}>
            {selected.length} of 50 {resourceLabel} selected.
          </p>

          {selected.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {selected.map((item) => (
                <li
                  key={item.id}
                  style={{ marginBottom: "8px", overflowWrap: "anywhere" }}
                >
                  {item.title ??
                    `Saved selection (${item.id.split("/").pop()})`}{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeResource(item.id)}
                    aria-label={`Remove ${item.title ?? "saved selection"}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: 0 }}>Select at least one item before saving.</p>
          )}
        </>
      ) : null}

      <p style={{ margin: 0 }}>
        Targeting controls visibility only. The widget still needs its existing
        app block or app embed placement.
      </p>

      {error ? (
        <p role="alert" style={{ margin: 0, color: "#b42318" }}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
