import { useRef, useState, useEffect, useCallback } from "react";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code, Italic, Link2, Link2Off, List,
  ListOrdered, Palette, Redo2, RemoveFormatting, Type, Underline, Undo2, Unlink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EMAIL_THEMES, themeByKey, FONT_CHOICES, SIZE_CHOICES, LINEHEIGHT_CHOICES,
  PARAGRAPH_GAP_CHOICES, toEmailHtml, fromEmailHtml, normalizeEmailLinkInput,
} from "./emailThemes";

interface Props {
  value: string;
  onChange: (html: string) => void;
  themeKey: string;
  onThemeKey: (key: string) => void;
  onInsertTag?: (insert: (tag: string) => void) => void;
  plain?: boolean; // plain-text mode: raw text, no HTML, no theme
}

const Tool = ({ onClick, active, title, children }: { onClick: () => void; active?: boolean; title: string; children: React.ReactNode }) => (
  <button
    type="button"
    title={title}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    className={cn(
      "w-7 h-7 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground",
      active && "bg-muted text-foreground",
    )}
  >
    {children}
  </button>
);

const Sel = ({ title, onPick, children, w }: { title: string; onPick: (value: string) => void; children: React.ReactNode; w?: string }) => (
  <select
    title={title}
    defaultValue=""
    onChange={(event) => {
      const value = event.target.value;
      event.target.selectedIndex = 0;
      if (value) onPick(value);
    }}
    className={cn("h-7 text-[11px] rounded border border-border bg-background text-muted-foreground px-1", w)}
  >
    {children}
  </select>
);

const TEXT_COLORS = [
  { label: "Black", value: "#000000" },
  { label: "Dark gray", value: "#444444" },
  { label: "Gray", value: "#777777" },
  { label: "Red", value: "#c62828" },
  { label: "Blue", value: "#2563eb" },
  { label: "Green", value: "#18864b" },
  { label: "Orange", value: "#d97706" },
];

function selectionBelongsTo(editor: HTMLElement, range: Range): boolean {
  const node = range.commonAncestorContainer;
  return node === editor || editor.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode);
}

function markEmptyBlocks(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>("p, div").forEach((block) => {
    const text = (block.textContent || "").replace(/\u00a0/g, "").trim();
    const hasMedia = !!block.querySelector("img, hr, table");
    if (!text && !hasMedia) block.setAttribute("data-empty-line", "true");
    else block.removeAttribute("data-empty-line");
  });
}

function unwrapLink(anchor: HTMLAnchorElement) {
  anchor.replaceWith(...Array.from(anchor.childNodes));
}

export default function RichEmailEditor({ value, onChange, themeKey, onThemeKey, plain }: Props) {
  // Plain-text mode: a bare textarea holding the raw text, exactly as it will send. No
  // toolbar, no theme, no HTML — what you type is what the recipient reads.
  if (plain) {
    return (
      <div className="border border-input rounded-lg bg-background overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">Plain text</span>
          <span>· no formatting, no HTML — sends exactly as typed, like a normal email</span>
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={"Hi {{first_name}},\n\nWrite your message here. Blank lines are kept.\n\nJustin"}
          className="w-full px-4 py-3 outline-none resize-y bg-background text-foreground min-h-[340px] leading-relaxed"
          style={{ fontFamily: "Helvetica, Arial, sans-serif", fontSize: 15, whiteSpace: "pre-wrap" }}
          spellCheck
        />
      </div>
    );
  }
  return <RichHtmlEditor value={value} onChange={onChange} themeKey={themeKey} onThemeKey={onThemeKey} />;
}

function RichHtmlEditor({ value, onChange, themeKey, onThemeKey }: Omit<Props, "plain">) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const settingFromValue = useRef(false);
  const previousThemeKey = useRef(themeKey);
  const [mode, setMode] = useState<"rich" | "html">("rich");
  const theme = themeByKey(themeKey);

  const rememberSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (selectionBelongsTo(editor, range)) savedRangeRef.current = range.cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return false;
    editor.focus();
    const range = savedRangeRef.current;
    if (!range || !selectionBelongsTo(editor, range)) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || settingFromValue.current) return;
    markEmptyBlocks(editor);
    onChange(toEmailHtml(editor.innerHTML, theme));
  }, [onChange, theme]);

  // Only external changes replace the editor DOM. The equality check prevents a normal
  // keystroke from resetting the caret when the parent stores the newly serialized HTML.
  useEffect(() => {
    const editor = editorRef.current;
    if (mode !== "rich" || !editor) return;
    const current = toEmailHtml(editor.innerHTML, theme);
    if (current === value) return;
    settingFromValue.current = true;
    editor.innerHTML = fromEmailHtml(value);
    markEmptyBlocks(editor);
    savedRangeRef.current = null;
    settingFromValue.current = false;
  }, [value, mode, theme]);

  useEffect(() => {
    if (mode !== "rich") return;
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* browser fallback */ }
    try { document.execCommand("styleWithCSS", false, "true"); } catch { /* browser fallback */ }
  }, [mode]);

  // A theme is a new default layer. Existing span and block overrides stay in the editor
  // DOM and are appended after the new defaults when the HTML is regenerated.
  useEffect(() => {
    if (previousThemeKey.current === themeKey) return;
    previousThemeKey.current = themeKey;
    if (mode === "rich") emit();
  }, [themeKey, mode, emit]);

  const runCommand = useCallback((command: string, commandValue?: string) => {
    restoreSelection();
    document.execCommand(command, false, commandValue);
    rememberSelection();
    emit();
  }, [emit, rememberSelection, restoreSelection]);

  const applyFontSize = useCallback((fontSize: number) => {
    if (!restoreSelection()) return;
    try { document.execCommand("styleWithCSS", false, "false"); } catch { /* browser fallback */ }
    document.execCommand("fontSize", false, "7");
    editorRef.current?.querySelectorAll<HTMLElement>('font[size="7"]').forEach((font) => {
      const span = document.createElement("span");
      Array.from(font.attributes).forEach((attr) => {
        if (attr.name !== "size") span.setAttribute(attr.name, attr.value);
      });
      span.style.fontSize = `${fontSize}px`;
      while (font.firstChild) span.appendChild(font.firstChild);
      font.replaceWith(span);
    });
    try { document.execCommand("styleWithCSS", false, "true"); } catch { /* browser fallback */ }
    rememberSelection();
    emit();
  }, [emit, rememberSelection, restoreSelection]);

  const selectedBlocks = useCallback((selector: string): HTMLElement[] => {
    const editor = editorRef.current;
    if (!editor || !restoreSelection()) return [];
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return [];
    const range = selection.getRangeAt(0);
    return Array.from(editor.querySelectorAll<HTMLElement>(selector)).filter((block) => {
      try { return range.intersectsNode(block); } catch { return false; }
    });
  }, [restoreSelection]);

  const applyLineHeight = useCallback((lineHeight: number) => {
    const blocks = selectedBlocks("p, div, li");
    blocks.forEach((block) => {
      block.style.lineHeight = String(lineHeight);
      block.setAttribute("data-email-line-height", String(lineHeight));
    });
    rememberSelection();
    emit();
  }, [emit, rememberSelection, selectedBlocks]);

  const applyParagraphGap = useCallback((gap: number) => {
    const blocks = selectedBlocks("p, div");
    blocks.forEach((block) => {
      block.style.marginBottom = `${gap}px`;
      block.setAttribute("data-email-gap", String(gap));
    });
    rememberSelection();
    emit();
  }, [emit, rememberSelection, selectedBlocks]);

  const addLink = () => {
    if (!restoreSelection()) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.getRangeAt(0).collapsed) {
      window.alert("Select the text you want to turn into a link first.");
      return;
    }

    const input = window.prompt("Link URL, email address, or {{dynamic_page_url}}:");
    const url = normalizeEmailLinkInput(input || "");
    if (url) runCommand("createLink", url);
  };

  const removeSelectedLink = () => {
    if (!restoreSelection()) return;
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const links = Array.from(editor.querySelectorAll<HTMLAnchorElement>("a")).filter((anchor) => {
      try { return range.intersectsNode(anchor); } catch { return false; }
    });

    if (links.length === 0) {
      const node = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as Element
        : range.startContainer.parentElement;
      const anchor = node?.closest<HTMLAnchorElement>("a");
      if (anchor && editor.contains(anchor)) links.push(anchor);
    }

    links.forEach(unwrapLink);
    savedRangeRef.current = null;
    editor.focus();
    emit();
  };

  const removeAllLinks = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.querySelectorAll<HTMLAnchorElement>("a").forEach(unwrapLink);
    savedRangeRef.current = null;
    editor.focus();
    emit();
  };

  const switchMode = (nextMode: "rich" | "html") => {
    if (nextMode === mode) return;
    if (mode === "rich") emit();
    setMode(nextMode);
  };

  const emailMaxWidth = theme.maxWidth == null ? "none" : `${theme.maxWidth}px`;

  return (
    <div className="border border-input rounded-lg bg-background overflow-hidden">
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border flex-wrap">
        {mode === "rich" ? (
          <>
            <Tool onClick={() => runCommand("undo")} title="Undo"><Undo2 className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("redo")} title="Redo"><Redo2 className="w-3.5 h-3.5" /></Tool>
            <span className="w-px h-4 bg-border mx-0.5" />
            <Tool onClick={() => runCommand("bold")} title="Bold"><Bold className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("italic")} title="Italic"><Italic className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("underline")} title="Underline"><Underline className="w-3.5 h-3.5" /></Tool>
            <span className="w-px h-4 bg-border mx-0.5" />
            <Tool onClick={() => runCommand("insertUnorderedList")} title="Bulleted list"><List className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("insertOrderedList")} title="Numbered list"><ListOrdered className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={addLink} title="Link selected text"><Link2 className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={removeSelectedLink} title="Remove link from selection"><Unlink className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={removeAllLinks} title="Remove every link from this email"><Link2Off className="w-3.5 h-3.5" /></Tool>
            <span className="w-px h-4 bg-border mx-0.5" />
            <Sel title="Font for selected text" onPick={(font) => runCommand("fontName", font)}>
              <option value="" disabled>Font</option>
              {FONT_CHOICES.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
            </Sel>
            <Sel title="Size for selected text" w="w-[62px]" onPick={(size) => applyFontSize(Number(size))}>
              <option value="" disabled>Size</option>
              {SIZE_CHOICES.map((size) => <option key={size} value={size}>{size}px</option>)}
            </Sel>
            <Sel title="Color for selected text" w="w-[72px]" onPick={(color) => runCommand("foreColor", color)}>
              <option value="" disabled>Color</option>
              {TEXT_COLORS.map((color) => <option key={color.value} value={color.value}>{color.label}</option>)}
            </Sel>
            <label title="Custom color for selected text" className="h-7 px-1.5 inline-flex items-center gap-1 rounded border border-border bg-background text-muted-foreground cursor-pointer">
              <Palette className="w-3.5 h-3.5" />
              <input
                type="color"
                defaultValue="#000000"
                aria-label="Custom text color"
                className="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
                onChange={(event) => runCommand("foreColor", event.target.value)}
              />
            </label>
            <Sel title="Line height for selected paragraphs" w="w-[70px]" onPick={(height) => applyLineHeight(Number(height))}>
              <option value="" disabled>Line</option>
              {LINEHEIGHT_CHOICES.map((height) => <option key={height.value} value={height.value}>{height.label}</option>)}
            </Sel>
            <Sel title="Space after selected paragraphs" w="w-[72px]" onPick={(gap) => applyParagraphGap(Number(gap))}>
              <option value="" disabled>Gap</option>
              {PARAGRAPH_GAP_CHOICES.map((gap) => <option key={gap} value={gap}>{gap}px</option>)}
            </Sel>
            <span className="w-px h-4 bg-border mx-0.5" />
            <Tool onClick={() => runCommand("justifyLeft")} title="Align left"><AlignLeft className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("justifyCenter")} title="Align center"><AlignCenter className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("justifyRight")} title="Align right"><AlignRight className="w-3.5 h-3.5" /></Tool>
            <Tool onClick={() => runCommand("removeFormat")} title="Clear selected formatting"><RemoveFormatting className="w-3.5 h-3.5" /></Tool>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground px-1">
            <Code className="w-3.5 h-3.5" /> Raw HTML
          </span>
        )}

        <div className="flex-1" />
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <Type className="w-3 h-3" />Defaults
        </span>
        <select
          value={themeKey}
          onChange={(event) => onThemeKey(event.target.value)}
          title="Email defaults"
          className="h-7 text-[11px] rounded border border-border bg-background text-foreground px-1"
        >
          {EMAIL_THEMES.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
        </select>
        <span className="w-px h-4 bg-border mx-0.5" />
        <div className="flex bg-muted/50 rounded-md p-0.5">
          {(["rich", "html"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => switchMode(item)}
              className={cn(
                "px-2 h-6 text-[11px] rounded capitalize transition-colors",
                mode === item ? "bg-background shadow-sm text-foreground font-medium" : "text-muted-foreground",
              )}
            >
              {item === "rich" ? "Visual" : "HTML"}
            </button>
          ))}
        </div>
      </div>

      {mode === "rich" ? (
        // The workspace stays full width. Only its direct email blocks use the theme's
        // line measure, so the writing surface is not reduced to a narrow card.
        <div className="overflow-y-auto min-h-[340px] max-h-[60vh] bg-muted/15">
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={emit}
            onBlur={() => { rememberSelection(); emit(); }}
            onMouseUp={rememberSelection}
            onKeyUp={rememberSelection}
            data-ph="Write your email. Blank lines and individual formatting are preserved."
            className={cn(
              "rev-email-editor w-full px-7 py-8 outline-none break-words min-h-[340px] bg-background",
              "[&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6",
              "empty:before:content-[attr(data-ph)] empty:before:text-muted-foreground/50",
            )}
            style={{
              fontFamily: theme.fontFamily,
              fontSize: `${theme.fontSize}px`,
              lineHeight: `${theme.lineHeight}px`,
              color: theme.color,
              ["--pg" as string]: `${theme.paragraphGap}px`,
              ["--email-max-width" as string]: emailMaxWidth,
            }}
          />
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={16}
          spellCheck={false}
          placeholder="<p>Hi {{first_name}},</p>"
          className="w-full px-3 py-2 outline-none resize-y font-mono text-xs bg-background text-foreground min-h-[340px]"
        />
      )}

      <style>{`
        .rev-email-editor > p,
        .rev-email-editor > div,
        .rev-email-editor > ul,
        .rev-email-editor > ol {
          width: 100%;
          max-width: var(--email-max-width, none);
          margin-left: 0;
          margin-right: auto;
        }
        .rev-email-editor > p,
        .rev-email-editor > div {
          margin-top: 0;
          margin-bottom: var(--pg, 0px);
        }
        .rev-email-editor > [data-empty-line="true"]:not([data-email-gap]) {
          margin-bottom: 0;
        }
        .rev-email-editor > :last-child:not([data-email-gap]) {
          margin-bottom: 0;
        }
      `}</style>
    </div>
  );
}
