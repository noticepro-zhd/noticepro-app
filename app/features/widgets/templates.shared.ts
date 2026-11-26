export type WidgetTemplateSolution = "ANNOUNCEMENT" | "NOTICE" | "COUNTDOWN";

export type WidgetTemplate = {
  id: string;
  label: string;
  message: string;
  backgroundColor: string;
  textColor: string;
};

export const WIDGET_TEMPLATES: Record<
  WidgetTemplateSolution,
  readonly WidgetTemplate[]
> = {
  ANNOUNCEMENT: [
    {
      id: "announcement-welcome",
      label: "Welcome",
      message: "Welcome to our store. Find something you will love.",
      backgroundColor: "#111827",
      textColor: "#FFFFFF",
    },
    {
      id: "announcement-new-arrivals",
      label: "New arrivals",
      message: "Discover our latest arrivals.",
      backgroundColor: "#1D4ED8",
      textColor: "#FFFFFF",
    },
    {
      id: "announcement-featured",
      label: "Featured collection",
      message: "Explore our featured collection.",
      backgroundColor: "#FDE68A",
      textColor: "#111827",
    },
  ],
  NOTICE: [
    {
      id: "notice-update",
      label: "Store update",
      message: "Check our latest store updates before placing your order.",
      backgroundColor: "#FEF3C7",
      textColor: "#111827",
    },
    {
      id: "notice-shipping",
      label: "Shipping information",
      message:
        "Please review our shipping policy for current dispatch information.",
      backgroundColor: "#DBEAFE",
      textColor: "#1E3A8A",
    },
    {
      id: "notice-support",
      label: "Customer support",
      message: "Have a question before ordering? Contact us for assistance.",
      backgroundColor: "#DCFCE7",
      textColor: "#14532D",
    },
  ],
  COUNTDOWN: [
    {
      id: "countdown-offer",
      label: "Offer countdown",
      message: "Special offer ends soon!",
      backgroundColor: "#0F766E",
      textColor: "#FFFFFF",
    },
    {
      id: "countdown-launch",
      label: "Launch countdown",
      message: "Something new is coming. Count down with us!",
      backgroundColor: "#312E81",
      textColor: "#FFFFFF",
    },
    {
      id: "countdown-last-chance",
      label: "Last chance",
      message: "Last chance to explore this offer.",
      backgroundColor: "#991B1B",
      textColor: "#FFFFFF",
    },
  ],
};

export function getWidgetTemplate(
  solution: WidgetTemplateSolution,
  id: string,
): WidgetTemplate | null {
  return (
    WIDGET_TEMPLATES[solution].find((template) => template.id === id) ?? null
  );
}
