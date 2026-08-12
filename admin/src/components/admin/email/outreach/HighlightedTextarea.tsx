import { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  singleLine?: boolean;
}

function highlightVars(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{\{([^}]+)\}\}/g, (_, name) =>
      `<mark class="var-chip">{{${name}}}</mark>`
    );
}

const HighlightedTextarea = forwardRef<HTMLTextAreaElement, Props>(
  ({ value, onChange, onFocus, placeholder, className, rows = 12, singleLine = false }, ref) => {
    const backdropRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => textareaRef.current!);

    const syncScroll = () => {
      if (textareaRef.current && backdropRef.current) {
        backdropRef.current.scrollTop = textareaRef.current.scrollTop;
        backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
      }
    };

    useEffect(() => {
      syncScroll();
    }, [value]);

    const highlighted = highlightVars(value) + (singleLine ? "" : "\n");

    return (
      <div className="relative">
        {/* Backdrop with syntax highlights */}
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={cn(
            "absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words",
            "rounded-md border border-transparent px-3 py-2 text-sm",
            singleLine ? "overflow-x-hidden h-9 leading-5" : "resize-none",
            "[&_.var-chip]:bg-primary/15 [&_.var-chip]:text-primary [&_.var-chip]:rounded [&_.var-chip]:px-0.5 [&_.var-chip]:font-mono [&_.var-chip]:not-italic",
            "font-mono text-transparent",
            className
          )}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
        {/* Transparent textarea on top */}
        {singleLine ? (
          <input
            ref={textareaRef as unknown as React.Ref<HTMLInputElement>}
            value={value}
            onChange={e => onChange(e.target.value)}
            onFocus={onFocus}
            onScroll={syncScroll}
            placeholder={placeholder}
            className={cn(
              "relative w-full h-9 border border-input rounded-md px-3 py-2 text-sm bg-transparent",
              "focus:outline-none focus:ring-2 focus:ring-ring font-mono caret-foreground text-foreground",
              "placeholder:text-muted-foreground placeholder:not-italic",
              className
            )}
          />
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onFocus={onFocus}
            onScroll={syncScroll}
            placeholder={placeholder}
            rows={rows}
            className={cn(
              "relative w-full border border-input rounded-md px-3 py-2 text-sm bg-transparent",
              "focus:outline-none focus:ring-2 focus:ring-ring font-mono resize-y caret-foreground text-foreground",
              "placeholder:text-muted-foreground placeholder:not-italic",
              className
            )}
          />
        )}
      </div>
    );
  }
);

HighlightedTextarea.displayName = "HighlightedTextarea";
export default HighlightedTextarea;
