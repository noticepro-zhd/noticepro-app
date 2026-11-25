(() => {
  const root = document.querySelector("[data-noticepro-announcement]");
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

  const createBar = (announcement) => {
    const storageKey =
      `noticepro-dismissed:${announcement.id}:` +
      encodeURIComponent(announcement.message.slice(0, 80));

    if (announcement.dismissible) {
      try {
        if (localStorage.getItem(storageKey) === "1") return null;
      } catch {
        // Keep displaying if browser storage is unavailable.
      }
    }

    const bar = document.createElement("div");
    bar.className = "noticepro-announcement-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Store announcement");
    bar.style.setProperty(
      "--noticepro-background",
      safeColor(announcement.backgroundColor, "#111827"),
    );
    bar.style.setProperty(
      "--noticepro-text",
      safeColor(announcement.textColor, "#ffffff"),
    );

    const message = document.createElement("span");
    message.className = "noticepro-announcement-message";
    message.textContent = announcement.message;
    bar.append(message);

    const href = safeHref(announcement.buttonUrl);
    if (
      typeof announcement.buttonText === "string" &&
      announcement.buttonText.trim() &&
      href
    ) {
      const link = document.createElement("a");
      link.className = "noticepro-announcement-link";
      link.href = href;
      link.textContent = announcement.buttonText;
      bar.append(link);
    }

    if (announcement.dismissible) {
      const close = document.createElement("button");
      close.className = "noticepro-announcement-close";
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss announcement");
      close.textContent = "×";
      close.addEventListener("click", () => {
        bar.remove();
        try {
          localStorage.setItem(storageKey, "1");
        } catch {
          // Dismiss for this page view even without storage.
        }
      });
      bar.append(close);
    }

    return bar;
  };

  async function renderAnnouncements() {
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
      const announcements = Array.isArray(payload?.announcements)
        ? payload.announcements
        : Array.isArray(payload)
          ? payload
          : payload
            ? [payload]
            : [];

      const topFragment = document.createDocumentFragment();
      const bottomFragment = document.createDocumentFragment();
      const seen = new Set();

      for (const announcement of announcements) {
        if (
          !announcement ||
          typeof announcement.id !== "string" ||
          !announcement.id ||
          typeof announcement.message !== "string" ||
          !announcement.message.trim() ||
          seen.has(announcement.id)
        ) {
          continue;
        }

        seen.add(announcement.id);
        const bar = createBar(announcement);
        if (!bar) continue;

        if (announcement.position === "BOTTOM") {
          bottomFragment.append(bar);
        } else {
          topFragment.append(bar);
        }
      }

      if (topFragment.childNodes.length) {
        root.classList.add("noticepro-announcement-stack");
        root.append(topFragment);
        document.body.prepend(root);
      }

      if (bottomFragment.childNodes.length) {
        const bottomRoot = document.createElement("div");
        bottomRoot.className = "noticepro-announcement-stack";
        bottomRoot.append(bottomFragment);
        document.body.append(bottomRoot);
      }
    } catch {
      // Fail quietly if the app proxy is unavailable.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAnnouncements, {
      once: true,
    });
  } else {
    renderAnnouncements();
  }
})();
