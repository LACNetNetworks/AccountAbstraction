// Copy-to-clipboard button for the truncated hashes in the write log.
//
// The table shows shortened hex, so the full value is only reachable through the
// title attribute — which cannot be copied. This gives it one click.

import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

// Inline SVG instead of an icon dependency: two small glyphs are not worth a
// package, and a bundled font would break the offline-friendly build.
function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);

  // A row can disappear on the next refresh; without this, the reset fires on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // The Clipboard API needs a secure context. 127.0.0.1 counts as one; a
      // plain-http LAN address does not, and that is the likely cause here.
      setState("failed");
    }
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setState("idle"), 1200);
  }

  return (
    <button
      type="button"
      className={`copy ${state}`}
      onClick={() => void copy()}
      // aria-label rather than text: the glyph is the whole control, and the
      // hash next to it already says which value this copies.
      aria-label={`Copy ${label}`}
      title={state === "failed" ? "The browser blocked clipboard access" : `Copy ${label}`}
    >
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
