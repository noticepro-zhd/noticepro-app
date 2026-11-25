(() => {
  const root = document.querySelector("[data-noticepro-notice]");
  if (!root || !root.dataset.endpoint) return;
  if (root.dataset.noticeproInitialized === "true") return;
  root.dataset.noticeproInitialized = "true";

  const safeColor = (value, fallback) =>
    typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
      ? value
      : fallback;

  const safeHref = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;

    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "https:" || url.protocol === "http:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  };

  async function getCountryAttestation() {
    const cacheKey = "__noticeproCountryAttestation";
    const existing = window[cacheKey];
    if (
      existing?.pending ||
      (existing?.expiresAt > Date.now() + 5000 && existing?.promise)
    ) {
      return existing.promise;
    }

    const entry = { pending: true, expiresAt: 0, promise: null };
    entry.promise = (async () => {
      const challengeUrl = new URL(
        "/apps/noticepro/country-challenge",
        window.location.origin,
      );
      const challengeResponse = await fetch(challengeUrl.href, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!challengeResponse.ok) return null;

      const challengeData = await challengeResponse.json();
      if (
        typeof challengeData?.challenge !== "string" ||
        challengeData.challenge.length > 2048 ||
        typeof challengeData?.workerUrl !== "string"
      ) {
        return null;
      }

      const workerUrl = new URL(challengeData.workerUrl);
      if (
        workerUrl.protocol !== "https:" ||
        workerUrl.username ||
        workerUrl.password ||
        workerUrl.pathname !== "/attest" ||
        workerUrl.search ||
        workerUrl.hash
      ) {
        return null;
      }

      const assertionResponse = await fetch(workerUrl.href, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "text/plain" },
        body: challengeData.challenge,
        cache: "no-store",
      });
      if (!assertionResponse.ok || assertionResponse.status === 204) return null;

      const assertionData = await assertionResponse.json();
      if (
        typeof assertionData?.assertion !== "string" ||
        assertionData.assertion.length > 2048 ||
        !Number.isSafeInteger(assertionData?.expiresAt) ||
        assertionData.expiresAt * 1000 <= Date.now() + 5000
      ) {
        return null;
      }

      entry.expiresAt = assertionData.expiresAt * 1000;
      return {
        challenge: challengeData.challenge,
        assertion: assertionData.assertion,
      };
    })()
      .then((attestation) => {
        if (!attestation) entry.expiresAt = Date.now() + 10_000;
        return attestation;
      })
      .catch(() => {
        entry.expiresAt = Date.now() + 10_000;
        return null;
      })
      .finally(() => {
        entry.pending = false;
      });

    window[cacheKey] = entry;
    return entry.promise;
  }

  const createCard = (notice) => {
    const storageKey =
      `noticepro-dismissed:${notice.id}:` +
      encodeURIComponent(notice.message.slice(0, 80));

    if (notice.dismissible) {
      try {
        if (localStorage.getItem(storageKey) === "1") return null;
      } catch {
        // Keep displaying if browser storage is unavailable.
      }
    }

    const card = document.createElement("div");
    card.className = "noticepro-notice-card";
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Store notice");
    card.setAttribute("aria-live", "polite");
    card.style.setProperty(
      "--noticepro-background",
      safeColor(notice.backgroundColor, "#FEF3C7"),
    );
    card.style.setProperty(
      "--noticepro-text",
      safeColor(notice.textColor, "#111827"),
    );

    const message = document.createElement("span");
    message.className = "noticepro-notice-message";
    message.textContent = notice.message;
    card.append(message);

    const href = safeHref(notice.buttonUrl);
    if (
      typeof notice.buttonText === "string" &&
      notice.buttonText.trim() &&
      href
    ) {
      const link = document.createElement("a");
      link.className = "noticepro-notice-link";
      link.href = href;
      link.textContent = notice.buttonText;
      card.append(link);
    }

    if (notice.dismissible) {
      const close = document.createElement("button");
      close.className = "noticepro-notice-dismiss";
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss store notice");
      close.textContent = "×";
      close.addEventListener("click", () => {
        card.remove();
        try {
          localStorage.setItem(storageKey, "1");
        } catch {
          // Dismiss for this page view even without storage.
        }
      });
      card.append(close);
    }

    return card;
  };

  async function renderNotices() {
    try {
      const endpoint = new URL(root.dataset.endpoint, window.location.origin);
      endpoint.searchParams.set("format", "multi");

      const pageType =
        root.dataset.pageType === "product"
          ? "product"
          : root.dataset.pageType === "collection"
            ? "collection"
            : "other";

      endpoint.searchParams.set("np_page", pageType);
      endpoint.searchParams.delete("np_product");
      endpoint.searchParams.delete("np_collection");

      // Keep IDs as strings to avoid JavaScript number precision loss.
      const numericId = /^[1-9][0-9]*$/;

      if (
        pageType === "product" &&
        numericId.test(root.dataset.productId || "")
      ) {
        endpoint.searchParams.set("np_product", root.dataset.productId);
      }

      if (
        pageType === "collection" &&
        numericId.test(root.dataset.collectionId || "")
      ) {
        endpoint.searchParams.set("np_collection", root.dataset.collectionId);
      }

      const attestation = await getCountryAttestation();
      const response = await fetch(endpoint.href, {
        ...(attestation
          ? {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(attestation),
            }
          : {}),
        credentials: "same-origin",
        ...(!attestation
          ? { headers: { Accept: "application/json" } }
          : {}),
        cache: "no-store",
      });

      if (!response.ok) return;

      const payload = await response.json();

      // Support the future envelope and the current single-widget response.
      const notices = Array.isArray(payload?.notices)
        ? payload.notices
        : Array.isArray(payload)
          ? payload
          : payload
            ? [payload]
            : [];

      const fragment = document.createDocumentFragment();
      const seen = new Set();

      for (const notice of notices) {
        if (
          !notice ||
          typeof notice.id !== "string" ||
          !notice.id ||
          typeof notice.message !== "string" ||
          !notice.message.trim() ||
          seen.has(notice.id)
        ) {
          continue;
        }

        seen.add(notice.id);
        const card = createCard(notice);
        if (card) fragment.append(card);
      }

      root.append(fragment);
    } catch {
      // Fail quietly if the app proxy is unavailable.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderNotices, {
      once: true,
    });
  } else {
    renderNotices();
  }
})();
