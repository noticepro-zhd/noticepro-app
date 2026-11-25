const attachedLifecycles = new WeakMap();

export function startCountryDatabaseBackgroundLifecycle(
  lifecycle,
  processLike = process,
) {
  if (
    !lifecycle ||
    typeof lifecycle.initialize !== "function" ||
    typeof lifecycle.isEnabled !== "function" ||
    typeof lifecycle.stop !== "function"
  ) {
    console.error(
      "NoticePro country database lifecycle unavailable; continuing with country resolution disabled.",
    );
    return { initialization: Promise.resolve({ status: "disabled" }) };
  }

  let attached = attachedLifecycles.get(processLike);
  if (!attached) {
    attached = new WeakSet();
    attachedLifecycles.set(processLike, attached);
  }

  let initialization;
  try {
    initialization = Promise.resolve(lifecycle.initialize());
  } catch {
    initialization = Promise.reject(
      new Error("Country database initialization failed."),
    );
  }

  void initialization.catch(() => {
    console.error("NoticePro country database initialization failed.");
  });

  let enabled = false;
  try {
    enabled = lifecycle.isEnabled();
  } catch {
    console.error(
      "NoticePro country database lifecycle status unavailable; continuing with country resolution disabled.",
    );
  }

  if (enabled && !attached.has(lifecycle)) {
    attached.add(lifecycle);
    const stop = () => {
      try {
        void Promise.resolve(lifecycle.stop()).catch(() => {
          console.error("NoticePro country database shutdown failed.");
        });
      } catch {
        console.error("NoticePro country database shutdown failed.");
      }
    };

    processLike.once("SIGTERM", stop);
    processLike.once("SIGINT", stop);
  }

  return { initialization };
}
