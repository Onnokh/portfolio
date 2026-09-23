// PROTOTYPE, throwaway: the bar that switches the fullscreen variants (see variants.ts). Dev only.
import { useEffect, useRef } from "react";
import { VARIANT, VARIANTS, prototypeState } from "./variants";

const current = VARIANTS.findIndex((v) => v.key === VARIANT);

// The card's geometry is built from the variant when the page loads, so a switch reloads.
function go(step: number) {
  const next = VARIANTS[(current + step + VARIANTS.length) % VARIANTS.length];
  const params = new URLSearchParams(location.search);
  if (next.key) params.set("variant", next.key);
  else params.delete("variant");
  const search = params.toString();
  location.search = search ? `?${search}` : "";
}

export function PrototypeSwitcher() {
  const stateRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]")) return;
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    addEventListener("keydown", onKey);
    let frame = 0;
    const tick = () => {
      if (stateRef.current && VARIANT)
        stateRef.current.textContent = `${Math.round(prototypeState.angle)}°${VARIANT === "scroll" ? ` · pan ${Math.round(prototypeState.pan * 100)}%` : ""}`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    };
  }, []);

  if (!import.meta.env.DEV) return null;
  const variant = VARIANTS[current];
  return (
    <div style={bar}>
      <button type="button" style={arrow} onClick={() => go(-1)} aria-label="Previous variant">
        ←
      </button>
      <span style={{ display: "grid", textAlign: "center", lineHeight: 1.25 }}>
        <span>
          {String.fromCharCode(65 + current)} · {variant.name}
        </span>
        <span ref={stateRef} style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }} />
      </span>
      <button type="button" style={arrow} onClick={() => go(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}

const bar: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: "max(12px, env(safe-area-inset-bottom))",
  transform: "translateX(-50%)",
  zIndex: 10,
  display: "flex",
  alignItems: "center",
  gap: 8,
  maxWidth: "calc(100vw - 24px)",
  padding: "6px 8px",
  boxSizing: "border-box",
  borderRadius: 999,
  background: "#ff2d6f",
  color: "#fff",
  font: "600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
  boxShadow: "0 6px 24px rgb(0 0 0 / 0.3)",
  whiteSpace: "nowrap",
};

const arrow: React.CSSProperties = {
  width: 30,
  height: 30,
  flexShrink: 0,
  border: 0,
  borderRadius: "50%",
  background: "rgb(255 255 255 / 0.2)",
  color: "inherit",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
};
