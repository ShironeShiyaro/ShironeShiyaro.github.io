import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { normalizePastedTitle } from '../lib/draft.ts';

interface EditableTextProps {
  id: string;
  labelId: string;
  multiline: boolean;
  value: string;
  /** Increment to push `value` back into the DOM (restore/discard/new post). */
  resetToken: number;
  onChange(value: string): void;
  className?: string;
  testId?: string;
  invalid?: boolean;
  describedBy?: string;
  elementRef: RefObject<HTMLSpanElement | null>;
}

function supportsPlaintextOnly(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const probe = document.createElement('div');
  probe.setAttribute('contenteditable', 'plaintext-only');
  return probe.contentEditable === 'plaintext-only';
}

/**
 * Chromium places the caret ambiguously at the end of a text node whose last
 * character is `\n`, and the next keystroke lands before that newline. A
 * zero-width space after inserted line breaks gives the caret a real
 * position; it is stripped from the value and never reaches the Markdown.
 */
const CARET_MARKER = '\u200B';

function readValue(element: HTMLElement): string {
  return (element.textContent ?? '').split(CARET_MARKER).join('');
}

function withCaretMarker(value: string): string {
  return value.endsWith('\n') ? `${value}${CARET_MARKER}` : value;
}

/**
 * Accessible plain-text editing surface.
 *
 * - No visible box: the parent heading/body styles own typography.
 * - `plaintext-only` where supported; otherwise `contenteditable=true` plus
 *   paste/drop/formatting/enter handling keeps the value plain text.
 * - Enter never inserts a paragraph element: a real `\n` text node is inserted
 *   so `textContent` round-trips the author's Markdown exactly.
 * - IME composition is never interrupted: Enter/beforeinput handlers bail out
 *   while composing (including Safari's keyCode 229 fallback).
 */
export default function EditableText({
  id,
  labelId,
  multiline,
  value,
  resetToken,
  onChange,
  className,
  testId,
  invalid = false,
  describedBy,
  elementRef,
}: EditableTextProps) {
  const [plaintextOnly] = useState(supportsPlaintextOnly);
  const composingRef = useRef(false);

  // Only push a value into the DOM on an explicit reset. Typing is
  // uncontrolled so React never fights the caret. `useLayoutEffect` runs before
  // paint, so the initial/restored value cannot race the first keystroke.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    if (element.textContent !== value) {
      element.textContent = withCaretMarker(value);
    }
  }, [resetToken]);

  const emitChange = () => {
    const element = elementRef.current;
    if (element) {
      onChange(readValue(element));
    }
  };

  /** Removes a newline leaked by an IME commit without touching normal input. */
  const sanitizeComposingTitle = () => {
    if (multiline) {
      return;
    }
    const element = elementRef.current;
    if (!element) {
      return;
    }
    const value = readValue(element);
    const normalized = normalizePastedTitle(value);
    if (normalized === value) {
      return;
    }
    element.textContent = normalized;
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  const handleInput = (event: FormEvent<HTMLSpanElement>) => {
    const native = event.nativeEvent as InputEvent;
    if (composingRef.current || native.isComposing) {
      sanitizeComposingTitle();
    }
    emitChange();
  };

  const insertPlainText = (text: string) => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    element.focus();
    const selection = window.getSelection();
    let range: Range | null = null;
    if (selection && selection.rangeCount > 0) {
      const candidate = selection.getRangeAt(0);
      if (element.contains(candidate.startContainer)) {
        range = candidate;
      }
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(withCaretMarker(text));
    range.insertNode(node);
    // Put the caret inside the inserted text node, at its end. Setting the
    // range "after the node" selects the following position in the parent and
    // makes the next keystroke land before the newline.
    const caret = document.createRange();
    caret.setStart(node, node.length);
    caret.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    emitChange();
  };

  const handleBeforeInput = (event: FormEvent<HTMLSpanElement>) => {
    const native = event.nativeEvent as InputEvent;
    if (native.inputType !== 'insertParagraph' && native.inputType !== 'insertLineBreak') {
      return;
    }
    // Always stop the browser's line-break insertion. IME confirmation can
    // still commit its composition text, but it must not add a newline to a
    // single-line title (and not to the body while composing either).
    event.preventDefault();
    if (!multiline) {
      return;
    }
    if (composingRef.current || native.isComposing) {
      return;
    }
    insertPlainText('\n');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (multiline) {
        insertPlainText('\n');
      }
      return;
    }
    // No rich-text toolbar and no rich-text shortcuts: the value stays source.
    if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (!text) {
      return;
    }
    insertPlainText(multiline ? text : normalizePastedTitle(text));
  };

  const handleDrop = (event: DragEvent<HTMLSpanElement>) => {
    // Dropped HTML/files must never become rich content in the source editor.
    event.preventDefault();
  };

  return (
    <span
      ref={elementRef}
      id={id}
      className={className}
      contentEditable={plaintextOnly ? 'plaintext-only' : 'true'}
      role="textbox"
      aria-multiline={multiline}
      aria-labelledby={labelId}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? describedBy : undefined}
      spellCheck={multiline}
      data-testid={testId}
      data-plaintext-only={plaintextOnly ? 'true' : 'false'}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onBeforeInput={handleBeforeInput}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        sanitizeComposingTitle();
        emitChange();
      }}
      suppressContentEditableWarning
    />
  );
}
