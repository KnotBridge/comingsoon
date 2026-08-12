import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children at document.body level.
 *
 * This prevents "fixed" overlays (like the Quiz Reveal screen) from being trapped
 * behind stacking contexts created by transformed ancestors.
 */
export function BodyPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
