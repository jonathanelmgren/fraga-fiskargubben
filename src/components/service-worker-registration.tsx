"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // Registration failure (private browsing, unsupported) is fine — the app
    // works without the SW, it just isn't installable.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}
