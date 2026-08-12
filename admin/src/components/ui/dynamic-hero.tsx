import { useCallback, useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";

interface CursorGuideArrowProps {
  targetRef: RefObject<HTMLElement>;
  enabled?: boolean;
  className?: string;
}

/** Draws a desktop cursor guide toward one primary action. */
function CursorGuideArrow({ targetRef, enabled = true, className }: CursorGuideArrowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const desktopPointerRef = useRef(false);

  const draw = useCallback((time: number) => {
    const canvas = canvasRef.current;
    const target = targetRef.current;
    const pointer = pointerRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) return;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);

    if (!enabled || !desktopPointerRef.current || !target || !pointer) return;

    const rect = target.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const deltaX = centerX - pointer.x;
    const deltaY = centerY - pointer.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < Math.max(rect.width, rect.height) * 0.72) return;

    const angle = Math.atan2(deltaY, deltaX);
    const endX = centerX - Math.cos(angle) * (rect.width / 2 + 12);
    const endY = centerY - Math.sin(angle) * (rect.height / 2 + 12);
    const midX = (pointer.x + endX) / 2;
    const midY = (pointer.y + endY) / 2;
    const bend = Math.min(110, Math.max(36, distance * 0.18));
    const curveDirection = pointer.y <= centerY ? 1 : -1;
    const controlX = midX - Math.sin(angle) * bend * curveDirection;
    const controlY = midY + Math.cos(angle) * bend * curveDirection;
    const opacity = Math.min(0.92, Math.max(0.25, (distance - rect.width / 2) / 430));

    context.save();
    context.strokeStyle = `rgba(166, 70, 38, ${opacity})`;
    context.lineWidth = 2;
    context.lineCap = "round";
    context.setLineDash([10, 7]);
    context.lineDashOffset = -(time / 34) % 17;
    context.beginPath();
    context.moveTo(pointer.x, pointer.y);
    context.quadraticCurveTo(controlX, controlY, endX, endY);
    context.stroke();

    const arrowAngle = Math.atan2(endY - controlY, endX - controlX);
    const headLength = 12;
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(
      endX - headLength * Math.cos(arrowAngle - Math.PI / 6),
      endY - headLength * Math.sin(arrowAngle - Math.PI / 6),
    );
    context.moveTo(endX, endY);
    context.lineTo(
      endX - headLength * Math.cos(arrowAngle + Math.PI / 6),
      endY - headLength * Math.sin(arrowAngle + Math.PI / 6),
    );
    context.stroke();
    context.restore();
  }, [enabled, targetRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;

    const pointerQuery = window.matchMedia("(min-width: 1024px) and (pointer: fine)");
    const updatePointerMode = () => {
      desktopPointerRef.current = pointerQuery.matches;
      if (!pointerQuery.matches) pointerRef.current = null;
    };
    const resizeCanvas = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const trackPointer = (event: MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    const animate = (time: number) => {
      draw(time);
      frameRef.current = window.requestAnimationFrame(animate);
    };

    updatePointerMode();
    resizeCanvas();
    pointerQuery.addEventListener("change", updatePointerMode);
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("mousemove", trackPointer, { passive: true });
    frameRef.current = window.requestAnimationFrame(animate);

    return () => {
      pointerQuery.removeEventListener("change", updatePointerMode);
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("mousemove", trackPointer);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [draw, enabled]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none fixed inset-0 z-40 hidden lg:block", className)}
    />
  );
}

export { CursorGuideArrow };
