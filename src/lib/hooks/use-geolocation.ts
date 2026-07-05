"use client";

import { useEffect, useRef, useState } from "react";
import {
  readShareLocationCookie,
  writeShareLocationCookie,
} from "@/lib/prefs-cookies";

export type GeoState = "off" | "loading" | "on" | "denied";

/**
 * Shared browser-geolocation toggle used by the landing hero and the chat
 * input. One tap requests the position, a second tap turns it off again.
 *
 * The on/off choice persists in a cookie (server-readable, so pages can pass
 * `initialOn` and the toggle renders in its restored state from the first
 * paint — no off→on flash). `onPrefChange` fires on user toggles so callers
 * can mirror the preference onto the account.
 */
export function useGeolocation(opts?: {
  initialOn?: boolean;
  onPrefChange?: (on: boolean) => void;
}) {
  const initialOn = opts?.initialOn ?? false;
  // A remembered "on" starts in "loading": the position request fires from
  // the mount effect and the pin renders active-ish immediately.
  const [geo, setGeo] = useState<GeoState>(initialOn ? "loading" : "off");
  const [coords, setCoords] = useState<
    { lat: number; lon: number } | undefined
  >(undefined);

  function requestPosition() {
    if (!("geolocation" in navigator)) {
      setGeo("denied");
      return;
    }
    setGeo("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGeo("on");
      },
      () => setGeo("denied"),
      { maximumAge: 300_000, timeout: 8_000 },
    );
  }

  // Restore once on mount. Server prop is primary; the cookie read is a
  // fallback for callers that render without server-passed prefs.
  const restoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once restore
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (initialOn || readShareLocationCookie() === true) requestPosition();
  }, []);

  const onPrefChange = opts?.onPrefChange;

  function toggleLocation() {
    if (geo === "on" || geo === "loading") {
      setGeo("off");
      setCoords(undefined);
      writeShareLocationCookie(false);
      onPrefChange?.(false);
      return;
    }
    writeShareLocationCookie(true);
    onPrefChange?.(true);
    requestPosition();
  }

  return { geo, coords, toggleLocation };
}
