import { useCallback, useEffect, useState } from "react";

type View = "landing" | "editor";

export function useView() {
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "landing";
    return window.location.hash.replace(/^#\/?/, "") === "editor" ? "editor" : "landing";
  });

  useEffect(() => {
    const sync = () => {
      setView(window.location.hash.replace(/^#\/?/, "") === "editor" ? "editor" : "landing");
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((next: View) => {
    window.location.hash = next === "editor" ? "#/editor" : "#/";
    setView(next);
  }, []);

  return { view, navigate };
}
