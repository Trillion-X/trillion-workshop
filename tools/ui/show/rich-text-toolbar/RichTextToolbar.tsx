// packages/ui/show/rich-text-toolbar/RichTextToolbar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A blind, DATA-driven formatting toolbar for any contentEditable rich-text
// surface (pairs with RichTextEditor). Each control is a self-describing
// `FormatCommand` (icon + the execCommand it runs against the focused editable
// selection); the toolbar never branches on WHICH command it is — adding a
// format = ONE data row, ZERO toolbar code (L069/L090). The host composes this
// above its editor; commands operate on whatever editable currently holds the
// selection, so the toolbar stays decoupled from any specific editor instance.
//
// =============================================================================
// THE THREE INPUT MODALITIES (Physics, not Society)
// =============================================================================
//
// A `document.execCommand` argument can be supplied in exactly three ways. This
// is a CLOSED set fixed by the contentEditable API itself (Physics) — it is NOT
// an open list of command names (which would be Society). The toolbar dispatches
// on the SHAPE of the data, never on the command's identity:
//
//   1. STATIC      — `value` (or nothing). One fixed argument, applied on tap.
//                    e.g. bold (no arg), heading (`formatBlock` → 'h1').
//   2. PROMPT      — `promptFor`. Ask the user for free text, then apply.
//                    e.g. link (`createLink` → typed URL).
//   3. CHOOSE      — `options`. Pick one value from a self-describing set, or
//                    type a free one (an option may itself `promptFor` a value).
//                    e.g. font (`fontName` → family, plus a "Custom…" free entry).
//
// Font is therefore DATA + free entry: a font list is an `options` array whose
// last row prompts for any typeface — never a closed set. (Text COLOUR / gradient
// / mesh / border is NOT a finite swatch list here — it is the infinite
// visual-layer paint, applied by the sibling `RichTextPaintControl`.)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary — pure text-formatting Physics, reusable anywhere.
// 2. Controls fire on pointer-DOWN with preventDefault so the editor keeps its
//    selection/focus (a click would blur the editor and lose the selection).
//    EVERY interactive element here (buttons, picker trigger, options, backdrop)
//    obeys this, or applying a colour/font to a selection would silently no-op.
// 3. The command set is DATA (prop); the defaults are conveniences, overridable.
// 4. `document.execCommand` is the standard, universally-supported mechanism for
//    contentEditable formatting — it is the correct tool here, not a shortcut.
//    `styleWithCSS` is enabled so formatting emits inline-`style` spans (which
//    survive HTML sanitisation / persistence) rather than deprecated <font> tags.
// =============================================================================

import React from 'react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link as LinkIcon,
  Type,
  ALargeSmall,
  RemoveFormatting,
  ChevronDown,
} from 'lucide-react';
import { Button } from '../button';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';
import { Input } from '../input';
import { ColorDot } from '../color-dot';
import { AnchoredOverlay } from '../anchored-overlay';

/** One selectable argument in a CHOOSE-modality command (a font, …). */
export interface FormatOption {
  /** Human label shown in the picker (and previewed in `value` when a font). */
  readonly label: string;
  /** The argument passed to `document.execCommand(command, false, value)`.
   *  Ignored when `promptFor` is set (the value is typed by the user instead). */
  readonly value: string;
  /** When set, the option renders as a colour dot of this CSS colour. */
  readonly swatch?: string;
  /** When set, selecting this option PROMPTS for a free value (infinite entry). */
  readonly promptFor?: string;
  /** A COMPOSITE style: a bundle of CSS properties applied together as ONE span
   *  (bold+italic+font+size+colour+… saved as a named, reusable style). The keys are
   *  camelCase CSS properties, the values their CSS strings — opaque DATA the toolbar
   *  applies verbatim. This is how a "saved text style" is reapplied in one click. */
  readonly composite?: Record<string, string>;
  /** CSS used to render this option's own label in the list — a font shows its
   *  name in that font, a saved style shows its name in the style. */
  readonly previewStyle?: Record<string, string>;
}

/** A self-describing formatting control: an icon + the execCommand it dispatches. */
export interface FormatCommand {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ size?: number }>;
  /** The `document.execCommand` name applied to the focused editable selection. */
  readonly command: string;
  /** STATIC modality: a fixed argument (e.g. `formatBlock` → `'h1'`). */
  readonly value?: string;
  /** PROMPT modality: prompt the user for the argument (e.g. a link URL). */
  readonly promptFor?: string;
  /** CHOOSE modality: pick the argument from this self-describing set. */
  readonly options?: ReadonlyArray<FormatOption>;
  /** STYLE modality: instead of execCommand, wrap the selection in a span and set
   *  this CSS property to the chosen/typed value. The open seam for anything
   *  execCommand can't express — font-size in arbitrary px, letter-spacing, etc.
   *  The toolbar never names the property; it is DATA on the command. */
  readonly styleProperty?: string;
  /** SAVE-STYLE modality: when set (together with {@link onSaveComposite}), the
   *  picker renders a "Save current as a style" input. Naming it captures the
   *  selection's effective values for THESE CSS properties into a composite bundle
   *  (DATA) the owner persists — then it reappears as a one-click saved-style option.
   *  The properties are DATA so the owner decides what a "style" captures. */
  readonly captureProperties?: readonly string[];
  /** Owner sink for a newly-saved composite style (name + captured bundle). The
   *  toolbar is blind to WHERE it persists (board DATA, a style record, …). */
  readonly onSaveComposite?: (name: string, composite: Record<string, string>) => void;
}

/** A minimal default set — overridable via the `commands` prop. */
export const DEFAULT_FORMAT_COMMANDS: ReadonlyArray<FormatCommand> = [
  { id: 'bold', label: 'Bold', icon: Bold, command: 'bold' },
  { id: 'italic', label: 'Italic', icon: Italic, command: 'italic' },
  { id: 'heading', label: 'Heading', icon: Heading2, command: 'formatBlock', value: 'h3' },
  { id: 'bullet', label: 'Bulleted list', icon: List, command: 'insertUnorderedList' },
  { id: 'numbered', label: 'Numbered list', icon: ListOrdered, command: 'insertOrderedList' },
  { id: 'link', label: 'Link', icon: LinkIcon, command: 'createLink', promptFor: 'Link URL' },
];

/**
 * A web-safe font palette (DATA — adding a typeface is one row) whose final row
 * PROMPTS for any font family, so the set is open, never a closed list. Text
 * COLOUR/gradient/mesh is deliberately NOT here — it is the infinite
 * visual-layer paint, applied by {@link RichTextPaintControl}, not execCommand.
 */
export const FORMAT_FONT_OPTIONS: ReadonlyArray<FormatOption> = [
  { label: 'System', value: 'system-ui, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet', value: '"Trebuchet MS", sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
  { label: 'Garamond', value: 'Garamond, "Times New Roman", serif' },
  { label: 'Courier', value: '"Courier New", Courier, monospace' },
  { label: 'Brush Script', value: '"Brush Script MT", cursive' },
  { label: 'Comic Sans', value: '"Comic Sans MS", cursive' },
  { label: 'Impact', value: 'Impact, Charcoal, sans-serif' },
  { label: 'Custom font…', value: '', promptFor: 'Font family (e.g. "Inter", Georgia, serif)' },
  // Each concrete font previews its OWN name in that font (the previewStyle DATA),
  // so the picker stays generic — it renders whatever previewStyle each option carries.
].map((o) => (o.value ? { ...o, previewStyle: { fontFamily: o.value } } : o));

/**
 * Block style (paragraph vs heading levels) as ONE open picker — never separate
 * H1/H2 buttons. Adding a level is one DATA row. Headings render at visible sizes
 * via the editor's scoped stylesheet (the global preflight flattens them).
 */
export const FORMAT_BLOCK_OPTIONS: ReadonlyArray<FormatOption> = [
  { label: 'Paragraph', value: 'p' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
  { label: 'Heading 4', value: 'h4' },
  { label: 'Heading 5', value: 'h5' },
  { label: 'Heading 6', value: 'h6' },
];

/**
 * Font SIZE presets (DATA) applied via the STYLE modality (an inline-style span,
 * since execCommand `fontSize` only does the legacy 1-7 scale). The set is open —
 * adding a size is one row; the final row PROMPTS for any value, so a user can
 * type a custom size. Sizes are px for predictability across notes.
 */
export const FORMAT_SIZE_OPTIONS: ReadonlyArray<FormatOption> = [
  { label: '12', value: '12px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '20', value: '20px' },
  { label: '24', value: '24px' },
  { label: '32', value: '32px' },
  { label: '48', value: '48px' },
  { label: '64', value: '64px' },
  { label: '96', value: '96px' },
  { label: 'Custom…', value: '', promptFor: 'Font size (e.g. 28px, 2rem, 150%)' },
];

/**
 * The rich default set — the structural formatting a writer expects (emphasis,
 * headings, alignment, lists, link) plus an OPEN font picker. These are the
 * Physics-closed text commands (bold IS bold). Infinite COLOUR/gradient/mesh/
 * border is NOT here — the host pairs this with {@link RichTextPaintControl}.
 * All of it is data; the toolbar code never names a single one of these commands.
 */
export const RICH_FORMAT_COMMANDS: ReadonlyArray<FormatCommand> = [
  { id: 'bold', label: 'Bold', icon: Bold, command: 'bold' },
  { id: 'italic', label: 'Italic', icon: Italic, command: 'italic' },
  { id: 'underline', label: 'Underline', icon: Underline, command: 'underline' },
  { id: 'strike', label: 'Strikethrough', icon: Strikethrough, command: 'strikeThrough' },
  { id: 'block', label: 'Paragraph / heading', icon: Heading1, command: 'formatBlock', options: FORMAT_BLOCK_OPTIONS },
  { id: 'size', label: 'Font size', icon: ALargeSmall, command: '', styleProperty: 'fontSize', options: FORMAT_SIZE_OPTIONS },
  { id: 'bullet', label: 'Bulleted list', icon: List, command: 'insertUnorderedList' },
  { id: 'numbered', label: 'Numbered list', icon: ListOrdered, command: 'insertOrderedList' },
  { id: 'align-left', label: 'Align left', icon: AlignLeft, command: 'justifyLeft' },
  { id: 'align-center', label: 'Align center', icon: AlignCenter, command: 'justifyCenter' },
  { id: 'align-right', label: 'Align right', icon: AlignRight, command: 'justifyRight' },
  { id: 'font', label: 'Font', icon: Type, command: 'fontName', options: FORMAT_FONT_OPTIONS },
  { id: 'link', label: 'Link', icon: LinkIcon, command: 'createLink', promptFor: 'Link URL' },
  { id: 'clear', label: 'Clear formatting', icon: RemoveFormatting, command: 'removeFormat' },
];

export interface RichTextToolbarProps {
  /** The formatting controls to render (DATA). Defaults to {@link DEFAULT_FORMAT_COMMANDS}. */
  readonly commands?: ReadonlyArray<FormatCommand>;
}

/** Apply an execCommand against the current selection (with a chosen/typed arg). */
function applyCommand(command: string, value?: string): void {
  if (typeof document === 'undefined') return;
  // Emit inline-style spans (survive sanitisation/persistence) over <font> tags.
  try {
    document.execCommand('styleWithCSS', false, 'true');
  } catch {
    /* styleWithCSS unsupported in some engines — the format still applies. */
  }
  document.execCommand(command, false, value);
}

/** STYLE modality (composite): wrap the current selection in ONE span and set a
 *  WHOLE bundle of CSS properties at once. A single property (arbitrary font-size)
 *  is just a one-entry bundle; a SAVED STYLE (bold+italic+font+size+colour+…) is a
 *  many-entry bundle reapplied in one click. The keys are camelCase CSS properties,
 *  the values opaque CSS strings the toolbar never inspects (L090). */
function applyCompositeStyle(styles: Record<string, string>): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return; // nothing selected → nothing to style
  const span = document.createElement('span');
  for (const [property, value] of Object.entries(styles)) {
    (span.style as unknown as Record<string, string>)[property] = value;
  }
  try {
    range.surroundContents(span);
  } catch {
    // Selection crosses element boundaries → extract its contents and re-wrap.
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  selection.removeAllRanges();
  const restored = document.createRange();
  restored.selectNodeContents(span);
  selection.addRange(restored);
}

/** STYLE modality (single property) — a one-entry composite (arbitrary font-size, …). */
function applyInlineStyle(property: string, value: string): void {
  applyCompositeStyle({ [property]: value });
}

/** camelCase → kebab-case for reading computed style values. */
function toKebabCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Read the selection's EFFECTIVE values for the given CSS properties — the CAPTURE
 *  path for "save the current formatting as a named style". Returns a composite
 *  bundle ready to store as DATA and reapply via {@link applyCompositeStyle}. */
export function captureSelectionStyle(properties: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === 'undefined') return out;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return out;
  let node: Node | null = selection.getRangeAt(0).startContainer;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!(node instanceof Element)) return out;
  const computed = window.getComputedStyle(node);
  for (const property of properties) {
    const value = computed.getPropertyValue(toKebabCase(property));
    if (value) out[property] = value;
  }
  return out;
}

/** Apply a RESOLVED value (a static option value OR a value the user typed into the
 *  in-app input) — via the STYLE modality (inline span) when the command declares a
 *  `styleProperty`, else via execCommand. The single apply path shared by static
 *  options and the Custom… input. */
function applyResolvedValue(cmd: FormatCommand, value: string): void {
  if (cmd.styleProperty) {
    applyInlineStyle(cmd.styleProperty, value);
    return;
  }
  applyCommand(cmd.command, value);
}

/** Apply a CHOOSE option: a COMPOSITE option (saved style) sets its whole CSS bundle
 *  in one span; otherwise its static value applies via {@link applyResolvedValue}.
 *  A `promptFor` option is NOT routed here — the picker renders an in-app input for it
 *  (window.prompt is dead in the macOS WKWebView shell). */
function runOption(cmd: FormatCommand, opt: FormatOption): void {
  if (opt.composite) {
    applyCompositeStyle(opt.composite);
    return;
  }
  applyResolvedValue(cmd, opt.value);
}

/** Snapshot the editor's current selection range. Typing into an in-app Input
 *  steals focus and can collapse the contentEditable selection, so we capture the
 *  range when the control opens and restore it right before applying. */
function captureSelection(): Range | null {
  if (typeof window === 'undefined') return null;
  const sel = window.getSelection();
  return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
}

/** Re-select a captured range so an apply lands on the originally-selected text. */
function restoreSelection(range: Range | null): void {
  if (!range || typeof window === 'undefined') return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The shared opaque, design-radius flyout surface (kills the see-through
 *  `bg-popover` token + square corners a user reported). */
function FlyoutSurface({ id, label, className, children }: { id: string; label: string; className: string; children: React.ReactNode }) {
  return (
    <div
      role="menu"
      aria-label={label}
      data-format-picker={id}
      style={{ backgroundColor: 'var(--black-rich)', color: 'var(--text-primary)', borderRadius: 'var(--radius-lg)' }}
      className={className}
    >
      {children}
    </div>
  );
}

/** In-app value entry — the WKWebView-safe replacement for window.prompt (which is
 *  dead in the macOS shell). Enter or Apply commits the typed value; the keystrokes
 *  are kept from bubbling to the canvas/editor shortcuts. `autoFocus` is opt-in:
 *  when this row lives ALONGSIDE clickable preset options (the size/font picker), it
 *  must NOT grab focus on open or it would drop the editor selection before the user
 *  even picks — the caller restores the captured range on apply instead. */
function PromptEntry({ placeholder, autoFocus = false, onSubmit }: { placeholder: string; autoFocus?: boolean; onSubmit: (value: string) => void }) {
  const [draft, setDraft] = React.useState('');
  const submit = (): void => {
    const value = draft.trim();
    if (value) onSubmit(value);
  };
  return (
    <Container layout="horizontal" gap="xs">
      <Input
        autoFocus={autoFocus}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          e.stopPropagation();
        }}
      />
      <Button variant="solid" size="sm" onMouseDown={(e) => { e.preventDefault(); submit(); }}>
        Apply
      </Button>
    </Container>
  );
}

/** A single STATIC/PROMPT control. STATIC applies on mouse-down (selection kept
 *  alive). PROMPT opens an in-app input overlay (no window.prompt). */
function FormatButton({ cmd }: { cmd: FormatCommand }) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const savedRangeRef = React.useRef<Range | null>(null);

  if (!cmd.promptFor) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={cmd.label}
        title={cmd.label}
        data-format-command={cmd.id}
        // pointer-DOWN + preventDefault keeps the editor's selection alive.
        onMouseDown={(e) => {
          e.preventDefault();
          applyCommand(cmd.command, cmd.value);
        }}
      >
        <Icon icon={cmd.icon} size="sm" />
      </Button>
    );
  }

  return (
    <div ref={anchorRef} className="relative inline-flex">
      <Button
        variant="ghost"
        size="icon"
        aria-label={cmd.label}
        title={cmd.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-format-command={cmd.id}
        onMouseDown={(e) => {
          e.preventDefault();
          savedRangeRef.current = captureSelection();
          setOpen((v) => !v);
        }}
      >
        <Icon icon={cmd.icon} size="sm" />
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} placement="above" onDismiss={() => setOpen(false)} dismissPreservesSelection flagAttr="data-rich-text-toolbar-panel">
        <FlyoutSurface id={cmd.id} label={cmd.label} className="w-56 border border-[var(--border-primary)] p-2 shadow-xl">
          <PromptEntry
            placeholder={cmd.promptFor}
            autoFocus
            onSubmit={(value) => {
              restoreSelection(savedRangeRef.current);
              applyCommand(cmd.command, value);
              setOpen(false);
            }}
          />
        </FlyoutSurface>
      </AnchoredOverlay>
    </div>
  );
}

/**
 * A CHOOSE control: tap the trigger → a flyout of self-describing options;
 * tap an option → apply it and close. Swatch options render as colour dots,
 * the rest as labels previewed in their own value (so fonts show in-font).
 * Every element fires on mouseDown+preventDefault to preserve the selection.
 */
function FormatPicker({ cmd }: { cmd: FormatCommand }) {
  const [open, setOpen] = React.useState(false);
  // The last value applied through this picker — shown on the trigger so the
  // control reads like a real size/heading selector ("28px ▾"), not a mystery icon.
  const [lastLabel, setLastLabel] = React.useState<string | null>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  // The editor selection captured when the flyout opens. Clicking a preset keeps the
  // live selection (mouse-down + preventDefault), but typing into the Custom input
  // steals focus and drops it — so EVERY apply restores this captured range first.
  const savedRangeRef = React.useRef<Range | null>(null);
  const options = cmd.options ?? [];
  const swatches = options.some((o) => o.swatch !== undefined);

  const close = (): void => setOpen(false);
  // Apply a static option: restore the captured selection, apply, record the label.
  const choose = (opt: FormatOption): void => {
    restoreSelection(savedRangeRef.current);
    runOption(cmd, opt);
    if (!swatches) setLastLabel(opt.label);
    close();
  };
  // Apply a typed Custom value (the in-app input replaces window.prompt).
  const applyTyped = (value: string): void => {
    restoreSelection(savedRangeRef.current);
    applyResolvedValue(cmd, value);
    setLastLabel(value);
    close();
  };
  // SAVE the current selection's formatting as a NAMED composite style (DATA). The
  // owner persists it (onSaveComposite) and feeds it back as a one-click option.
  const canSaveStyle = !!cmd.onSaveComposite && !!cmd.captureProperties?.length;
  const saveStyle = (name: string): void => {
    restoreSelection(savedRangeRef.current);
    const composite = captureSelectionStyle(cmd.captureProperties ?? []);
    cmd.onSaveComposite?.(name, composite);
    close();
  };

  return (
    <div ref={anchorRef} className="relative inline-flex">
      <Button
        variant="ghost"
        size={lastLabel && !swatches ? 'sm' : 'icon'}
        aria-label={cmd.label}
        title={lastLabel ? `${cmd.label}: ${lastLabel}` : cmd.label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-format-command={cmd.id}
        onMouseDown={(e) => {
          e.preventDefault();
          savedRangeRef.current = captureSelection();
          setOpen((v) => !v);
        }}
      >
        <Icon icon={cmd.icon} size="sm" />
        {lastLabel && !swatches ? <Text variant="body-xs">{lastLabel}</Text> : null}
        <Icon icon={ChevronDown} size="sm" />
      </Button>
      {/* The flyout is PORTALED above the trigger via the shared AnchoredOverlay
          so it escapes the toolbar/note clip (a user: "cut off / inside the
          container"), carries the SOLID opaque surface (never the empty
          `bg-popover` token → see-through) and the design radius, and dismisses
          on outside pointer-down WITHOUT stealing the editor selection. */}
      <AnchoredOverlay
        anchorRef={anchorRef}
        open={open}
        placement="above"
        onDismiss={close}
        dismissPreservesSelection
        flagAttr="data-rich-text-toolbar-panel"
      >
        <FlyoutSurface
          id={cmd.id}
          label={cmd.label}
          className={
            swatches
              ? 'grid grid-cols-6 gap-1 border border-[var(--border-primary)] p-2 shadow-xl'
              : 'flex w-44 flex-col gap-1 border border-[var(--border-primary)] p-1 shadow-xl'
          }
        >
          {swatches ? (
            options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="menuitem"
                aria-label={opt.label}
                title={opt.label}
                data-format-option={opt.value}
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-white/10"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(opt);
                }}
              >
                <ColorDot color={opt.swatch ?? 'transparent'} size="md" />
              </button>
            ))
          ) : (
            <>
              {/* Save the current selection's formatting as a NAMED reusable style
                  (DATA). Pinned at top; naming it captures + persists via the owner. */}
              {canSaveStyle ? (
                <PromptEntry placeholder="Save selection as a style…" onSubmit={saveStyle} />
              ) : null}
              {/* Custom-entry rows are PINNED at the top so they are ALWAYS clickable;
                  the presets scroll beneath them. A long preset list previously pushed
                  the input below the flyout's own clip → its hit-box landed on the
                  backdrop and the click dismissed the flyout. The in-app input replaces
                  window.prompt (dead in the macOS WKWebView shell). */}
              {options
                .filter((o) => o.promptFor)
                .map((opt) => (
                  <PromptEntry key={opt.label} placeholder={opt.promptFor as string} onSubmit={applyTyped} />
                ))}
              <div className="flex max-h-56 flex-col gap-1 overflow-auto">
                {options
                  .filter((o) => !o.promptFor)
                  .map((opt) => (
                    <button
                      key={opt.value || opt.label}
                      type="button"
                      role="menuitem"
                      data-format-option={opt.value}
                      className="rounded px-2 py-1 text-left text-sm hover:bg-white/10"
                      style={opt.previewStyle as React.CSSProperties | undefined}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(opt);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
              </div>
            </>
          )}
        </FlyoutSurface>
      </AnchoredOverlay>
    </div>
  );
}

/** A command is a PICKER (flyout) when it offers options to choose from OR can
 *  save the current selection into a named style. Otherwise it is a static/prompt
 *  button. A save-capable command must stay a picker even with ZERO options yet —
 *  the "save selection as a style…" entry lives in the flyout, so a static button
 *  would make the first style un-saveable (chicken-and-egg). */
function isPickerCommand(cmd: FormatCommand): boolean {
  const hasOptions = !!cmd.options && cmd.options.length > 0;
  const canSave = !!cmd.onSaveComposite && !!cmd.captureProperties?.length;
  return hasOptions || canSave;
}

export function RichTextToolbar({ commands = DEFAULT_FORMAT_COMMANDS }: RichTextToolbarProps) {
  return (
    <Container layout="horizontal" gap="xs">
      {commands.map((cmd) =>
        isPickerCommand(cmd) ? <FormatPicker key={cmd.id} cmd={cmd} /> : <FormatButton key={cmd.id} cmd={cmd} />,
      )}
    </Container>
  );
}

/** Controlled editor commands use the same toolbar and button owner as native
 * rich HTML editing. The caller supplies active state and an action; no DOM
 * formatting or persistence is invented by this presentation mode. */
export type TextToolbarAction = {
  id: string; label: string; icon?: React.ReactNode; group?: string; swatch?: string;
  active: boolean; onSelect: () => void;
  /** Increment to open this action's prompt from a scoped editor keyboard shortcut. */
  promptRequest?: number;
  /** Optional caller-owned free-value action (for example, a persisted inline link). */
  prompt?: {
    /** The selected content stays visible while its value is edited. */
    anchorRange?: Range;
    label: string; placeholder: string; value?: string; submitLabel?: string; removeLabel?: string;
    onSubmit: (value: string) => void; onRemove?: () => void; validate?: (value: string) => string | null;
  };
};

function PromptToolbarAction({ action }: { action: TextToolbarAction }) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(action.prompt?.value ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const seenPromptRequest = React.useRef(action.promptRequest ?? 0);
  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  React.useEffect(() => {
    const request = action.promptRequest ?? 0;
    if (request !== seenPromptRequest.current) { seenPromptRequest.current = request; setOpen(true); }
  }, [action.promptRequest]);
  const prompt = action.prompt!;
  const apply = () => {
    const value = draft.trim();
    if (!value) return;
    const problem = prompt.validate?.(value) ?? null;
    if (problem) { setError(problem); return; }
    prompt.onSubmit(value);
    setOpen(false);
  };
  return <div ref={anchorRef} className="relative inline-flex">
    <Button variant="ghost" size="icon" targetRole="reference" work={null} type="button" className="ca-format-btn"
      active={action.active || open} aria-pressed={action.active} aria-haspopup="dialog" aria-expanded={open}
      aria-label={action.label} title={action.label} onPointerDown={event => event.preventDefault()}
      onClick={() => { setDraft(prompt.value ?? ''); setError(null); setOpen(value => !value); }}>{action.icon ?? action.label}</Button>
    <AnchoredOverlay open={open} anchorRef={prompt.anchorRange ? undefined : anchorRef}
      anchorRange={prompt.anchorRange} placement={prompt.anchorRange ? 'below' : 'above'} gap={6} surface={false}
      onDismiss={() => setOpen(false)} dismissPreservesSelection flagAttr="data-rich-text-toolbar-panel">
      <div role="dialog" aria-label={prompt.label}
        className="w-72 rounded-[var(--radius-lg)] border border-[var(--border-primary)] bg-[var(--black-rich)] p-2 text-[var(--text-primary)] shadow-xl"
        onKeyDown={event => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
          else if (event.key === 'Enter') { event.preventDefault(); apply(); }
        }}>
        <Input ref={inputRef} type="text" value={draft} aria-label={prompt.label} placeholder={prompt.placeholder}
          error={error ?? undefined} onChange={event => { setDraft(event.currentTarget.value); setError(null); }} />
        <div className="mt-2 flex items-center justify-end gap-1">
          {prompt.onRemove && prompt.removeLabel ? <Button variant="ghost" size="sm" onClick={() => { prompt.onRemove?.(); setOpen(false); }}>{prompt.removeLabel}</Button> : null}
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="solid" size="sm" disabled={!draft.trim()} onClick={apply}>{prompt.submitLabel ?? 'Apply'}</Button>
        </div>
      </div>
    </AnchoredOverlay>
  </div>;
}

export function ControlledTextToolbar({ actions, onEscape }: { actions: readonly TextToolbarAction[]; onEscape: () => void }) {
  const [openGroup, setOpenGroup] = React.useState<string | null>(null);
  const groups = new Map<string, TextToolbarAction[]>();
  for (const action of actions) {
    const name = action.group ?? '';
    const rows = groups.get(name) ?? [];
    rows.push(action); groups.set(name, rows);
  }
  const moveFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpenGroup(null); onEscape(); return; }
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); event.stopPropagation();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (Math.max(0, current) + direction + buttons.length) % buttons.length;
    buttons[index].focus(); buttons[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  return <div className="ca-format-bar" role="toolbar" aria-label="Format text" onKeyDown={moveFocus}>
    {[...groups].map(([name, rows], index) => <React.Fragment key={name}>
      {index > 0 ? <span className="ca-format-sep" aria-hidden="true" /> : null}
      {rows.every(row => row.swatch) ? <ToolbarSwatches label={name} actions={rows}
        open={openGroup === name} onOpen={() => setOpenGroup(openGroup === name ? null : name)}
        onClose={() => setOpenGroup(null)} onKeyDown={moveFocus} />
        : rows.map(action => action.prompt
          ? <PromptToolbarAction key={action.id} action={action} />
          : <Button key={action.id} variant="ghost" size="icon" targetRole="reference" work={null}
            type="button" className="ca-format-btn" active={action.active} aria-pressed={action.active}
            aria-label={action.label} title={action.label} onPointerDown={event => event.preventDefault()}
            onClick={action.onSelect}>{action.icon ?? action.label}</Button>)}
    </React.Fragment>)}
  </div>;
}

function ToolbarSwatches({ label, actions, open, onOpen, onClose, onKeyDown }: {
  label: string; actions: readonly TextToolbarAction[]; open: boolean;
  onOpen: () => void; onClose: () => void; onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  return <div ref={anchorRef} className="inline-flex">
    <Button variant="ghost" size="icon" targetRole="reference" work={null} className="ca-format-btn"
      type="button" active={open} aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open}
      onPointerDown={event => event.preventDefault()} onClick={onOpen}>
      <span className="ca-format-swatch-indicator" style={{ background: actions.find(row => row.active)?.swatch
        ?? 'conic-gradient(from 90deg, #e03e3e, #d9730d, #dfab01, #0f9960, #0b6bcb, #6940a5, #e03e3e)' }} />
    </Button>
    <AnchoredOverlay open={open} anchorRef={anchorRef} placement="below" gap={6} surface={false}
      onDismiss={onClose} dismissPreservesSelection>
      <div className="ca-format-swatches" role="listbox" aria-label={label} onKeyDown={onKeyDown}>
        {actions.map(action => <Button key={action.id} variant="ghost" size="icon" targetRole="reference" work={null}
          type="button" role="option" className="ca-format-swatch" active={action.active} aria-selected={action.active}
          aria-label={action.label} title={action.label} onPointerDown={event => event.preventDefault()}
          onClick={() => { action.onSelect(); onClose(); }}>
          <span className="ca-format-swatch-chip" style={{ background: action.swatch }} />
        </Button>)}
      </div>
    </AnchoredOverlay>
  </div>;
}
