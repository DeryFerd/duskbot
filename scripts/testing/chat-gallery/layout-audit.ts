// The layout check the chat gallery and the isolated desktop run share. It reads only the DOM, so it runs in the gallery
// page and, through `auditLayout.toString()`, in any page a test drives. Keep it self-contained: no imports, no closures
// over module scope, plain DOM calls only.

export interface LayoutIssue {
  kind: "overlap" | "clipped" | "offscreen" | "field-style" | "native-control" | "focus" | "tap-target" | "contrast";
  /** Hard issues fail the gallery; soft ones are listed for a person to judge. */
  hard: boolean;
  where: string;
  detail: string;
}

export interface AuditOptions {
  /** The transcript's rows; each in-flow child (through display: contents) is one row. */
  rowsSelector?: string;
  /** Everything else checked: overflow, viewport, fields, focus, targets, contrast. */
  scopeSelector?: string;
  /** Phone layout: interactive targets are held to 24px hard, 44px soft. */
  touch?: boolean;
  /** Focus each control and compare its look: slow, so the gallery runs it once per scenario. */
  focus?: boolean;
}

export function auditLayout(options: AuditOptions = {}): LayoutIssue[] {
  const rowsSelector = options.rowsSelector ?? "[data-simple-rows]";
  const scopeSelector = options.scopeSelector ?? "[data-simple-rows], [data-composer-dock], [role=dialog]";
  const issues: LayoutIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: LayoutIssue) => {
    const key = `${issue.kind}|${issue.where}|${issue.detail}`;
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
  };
  const describe = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const marks = Array.from(node.attributes).filter((attr) => attr.name.startsWith("data-") && attr.name !== "data-state").map((attr) => `[${attr.name}${attr.value && attr.value.length < 24 ? `=${attr.value}` : ""}]`).join("");
      const label = node.getAttribute("aria-label");
      parts.unshift(`${node.tagName.toLowerCase()}${marks}${label ? `[aria-label="${label.slice(0, 30)}"]` : ""}`);
      if (marks) break;
    }
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${parts.join(" > ")}${text ? ` "${text}"` : ""}`;
  };
  // a closed <details> keeps its body laid out but never paints it
  const folded = (element: Element) => { const fold = element.parentElement?.closest("details:not([open])"); return Boolean(fold && !element.closest("summary")); };
  const visible = (element: Element) => {
    if (folded(element)) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hiddenByAncestor = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
      if (node.getAttribute("aria-hidden") === "true" && node !== element) return false;
    }
    return false;
  };
  const parse = (color: string) => {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match) return null;
    const [r, g, b, a = "1"] = match[1]!.split(/[\s,/]+/).filter(Boolean);
    return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
  };
  // an input kept for screen readers and drawn by the element beside it (Tailwind sr-only)
  const readerOnly = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width <= 2 && rect.height <= 2 || style.clip !== "auto" && style.clip !== "" || style.clipPath.startsWith("inset(50%");
  };
  const flowChildren = (parent: Element): Element[] => Array.from(parent.children).flatMap((child) =>
    getComputedStyle(child).display === "contents" ? flowChildren(child) : [child]);
  const inFlow = (element: Element) => {
    const position = getComputedStyle(element).position;
    return position !== "absolute" && position !== "fixed";
  };
  // what a row paints: its box plus anything inside that escapes it and is not clipped on the way out
  const inkRect = (element: Element) => {
    const rect = element.getBoundingClientRect();
    let { top, bottom, left, right } = rect;
    const walk = (node: Element, clip: { top: number; bottom: number; left: number; right: number }) => {
      for (const child of Array.from(node.children)) {
        const style = getComputedStyle(child);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || folded(child)) continue;
        // a drawing surface (the bot's mark) keeps transparent room around what it draws: its box is not its paint
        if (child.tagName === "CANVAS") continue;
        // an open menu or popover floats over the rows on purpose: it is an overlay, not the row's own paint
        if (child.matches('[role="menu"], [role="listbox"], .popover-surface, .menu-surface, [role="dialog"]:not([aria-modal="true"])')) continue;
        // a resize grip straddles its pane's edge on purpose, a transparent strip to drag
        if (style.cursor.endsWith("resize") && (parse(style.backgroundColor)?.a ?? 0) === 0) continue;
        // a popover's click-catcher (fixed, no fill, no edge, nothing inside) takes the press outside it and paints nothing
        if (style.position === "fixed" && !child.children.length && !child.textContent?.trim() && (parse(style.backgroundColor)?.a ?? 0) === 0
          && style.backgroundImage === "none" && style.boxShadow === "none" && parseFloat(style.borderTopWidth) + parseFloat(style.borderLeftWidth) === 0) continue;
        const box = child.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          const t = Math.max(box.top, clip.top), b = Math.min(box.bottom, clip.bottom);
          if (b > t) { top = Math.min(top, t); bottom = Math.max(bottom, b); left = Math.min(left, Math.max(box.left, clip.left)); right = Math.max(right, Math.min(box.right, clip.right)); }
        }
        const clips = style.overflowX !== "visible" || style.overflowY !== "visible" || style.contain.includes("paint");
        walk(child, clips ? { top: Math.max(clip.top, box.top), bottom: Math.min(clip.bottom, box.bottom), left: Math.max(clip.left, box.left), right: Math.min(clip.right, box.right) } : clip);
      }
    };
    // a scroller paints only inside its own box: what scrolls past its edge is hidden, not over its sibling
    const own = getComputedStyle(element);
    const scrolls = own.overflowX !== "visible" || own.overflowY !== "visible" || own.contain.includes("paint");
    walk(element, scrolls ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity });
    return { top, bottom, left, right };
  };

  // why a row's box is shorter than what it paints: the first thing to look at when an overlap is reported
  const why = (row: Element) => {
    const notes: string[] = [];
    for (let node: Element | null = row, depth = 0; node && depth < 6; node = node.firstElementChild, depth++) {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const animations = node.getAnimations?.().length ?? 0;
      if (Math.abs(node.scrollHeight - box.height) > 2 || style.transform !== "none" || animations || style.height !== "auto" && (node as HTMLElement).style.height)
        notes.push(`${node.tagName.toLowerCase()} box ${Math.round(box.height)} content ${node.scrollHeight} h ${style.height} min ${style.minHeight} flex ${style.flexShrink} transform ${style.transform} anim ${animations}`);
    }
    return notes.join(" / ") || "no clue";
  };
  // 1. rows: each row's paint ends before the next row's begins
  for (const rows of Array.from(document.querySelectorAll(rowsSelector))) {
    // a row still rising into place (use-arrival-flow.ts) is motion, not layout: it is judged once it lands
    const moving = (element: Element) => element.getAnimations?.({ subtree: true }).some((animation) => animation.playState === "running") ?? false;
    const list = flowChildren(rows).filter((element) => inFlow(element) && visible(element) && !moving(element));
    for (let i = 1; i < list.length; i++) {
      const upper = inkRect(list[i - 1]!), lower = inkRect(list[i]!);
      const overlap = upper.bottom - lower.top;
      const across = Math.min(upper.right, lower.right) - Math.max(upper.left, lower.left);
      if (overlap > 1 && across > 1) push({ kind: "overlap", hard: true, where: describe(list[i]!), detail: `paints ${Math.round(overlap)}px over the row above (${describe(list[i - 1]!)}; ${why(list[i - 1]!)})` });
    }
  }

  const scopes = Array.from(document.querySelectorAll(scopeSelector));
  const inScope = scopes.flatMap((scope) => [scope, ...Array.from(scope.querySelectorAll("*"))]);
  const vw = document.documentElement.clientWidth;

  for (const element of inScope) {
    if (!visible(element) || hiddenByAncestor(element)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    // 2. in-flow siblings inside a card never sit on one another
    if (element.children.length > 1 && style.display !== "contents" && !element.matches(rowsSelector)) {
      // inline runs wrap: their boxes span lines and say nothing about overlap
      const kids = flowChildren(element).filter((kid) => inFlow(kid) && visible(kid) && !kid.matches("svg, svg *") && getComputedStyle(kid).display !== "inline");
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        // what each sibling paints, so a control spilling out of its own capped box is caught where it lands
        const a = inkRect(kids[i]!), b = inkRect(kids[j]!);
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // a stack of small faces (app logos, avatars) overlaps on purpose
        const small = (box: { left: number; right: number; top: number; bottom: number }) => box.right - box.left <= 32 && box.bottom - box.top <= 32;
        if (small(a) && small(b)) continue;
        if (w > 4 && h > 4) push({ kind: "overlap", hard: true, where: describe(kids[j]!), detail: `sits ${Math.round(w)}x${Math.round(h)}px on its sibling ${describe(kids[i]!)}` });
      }
    }
    // 3. content cut off by a box that neither scrolls nor ellipsizes on purpose
    const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
    const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
    // an ellipsis, a line clamp or a fade mask is a deliberate end to text that does not fit
    const faded = (node: Element | null) => { for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) { const look = getComputedStyle(node); if (look.maskImage !== "none" && look.maskImage !== "" || (look as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage?.startsWith("linear")) return true; } return false; };
    const ellipsis = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none" && style.webkitLineClamp !== "" || faded(element);
    // what is cut must be something a person would see: a parked, transparent peek (the row's time) is not
    const spills = (axis: "x" | "y") => {
      const edge = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("*")).some((child) => {
        const box = child.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || !visible(child) || hiddenByAncestor(child)) return false;
        // what a scroller inside scrolls past its own edge is that scroller's to show (and judged there), not this box's to cut
        for (let node = child.parentElement; node && node !== element; node = node.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(node)[axis === "x" ? "overflowX" : "overflowY"])) return false;
        }
        return axis === "x" ? box.right > edge.right + 2 || box.left < edge.left - 2 : box.bottom > edge.bottom + 2 || box.top < edge.top - 2;
      }) || Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim());
    };
    // screen-reader-only text and decorative (aria-hidden) copies are cut on purpose or never seen
    const unseen = readerOnly(element) || Boolean(element.closest("[aria-hidden=true]"));
    if (!ellipsis && !unseen && element.tagName !== "IMG" && element.tagName !== "VIDEO" && element.tagName !== "CANVAS") {
      const textual = (element.textContent ?? "").trim().length > 0;
      if (textual && clipsX && element.scrollWidth > element.clientWidth + 2 && spills("x")) push({ kind: "clipped", hard: true, where: describe(element), detail: `cuts off ${element.scrollWidth - element.clientWidth}px of its content sideways` });
      if (textual && clipsY && element.scrollHeight > element.clientHeight + 2 && !element.closest("[data-gallery-allow-clip]") && spills("y")) push({ kind: "clipped", hard: true, where: describe(element), detail: `cuts off ${element.scrollHeight - element.clientHeight}px of its content below` });
    }
    // 4. nothing runs out of the window sideways
    if (rect.right > vw + 1 || rect.left < -1) {
      let clipped = false;
      for (let node = element.parentElement; node; node = node.parentElement) {
        const parent = getComputedStyle(node);
        if (parent.overflowX !== "visible" && node.getBoundingClientRect().right <= vw + 1 && node.getBoundingClientRect().left >= -1) { clipped = true; break; }
      }
      if (!clipped) push({ kind: "offscreen", hard: true, where: describe(element), detail: `reaches ${Math.round(rect.left)}..${Math.round(rect.right)}px in a ${vw}px window` });
    }
  }

  // 5. one field look: text fields share a fill, radius, border and type size; checkboxes are drawn, never native
  const fields = inScope.filter((element) => element.matches("input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=file]), textarea, select") && visible(element) && !element.closest("[data-composer-row], [data-composer-dock]"));
  // a bare field inside a painted row (a reply line, a search box) is drawn by that row
  const painted = (element: Element): Element | null => {
    let node: Element = element;
    for (let depth = 0; depth < 3 && node.parentElement; depth++) {
      const style = getComputedStyle(node);
      if (parse(style.backgroundColor)?.a || parseFloat(style.borderTopWidth) > 0) return node;
      node = node.parentElement;
    }
    return null;
  };
  // fill, corners and line: what makes two fields read as two kinds. A field nothing paints is part of a row, not a box.
  const signature = (box: Element) => {
    const style = getComputedStyle(box);
    return `fill ${style.backgroundColor}, radius ${style.borderTopLeftRadius}, border ${style.borderTopWidth} ${style.borderTopStyle}`;
  };
  // one look per surface: a settings page's fields match each other, a chat's cards match each other
  for (const scope of scopes) {
    const looks = new Map<string, Element[]>();
    for (const field of fields) {
      if (scopes.find((one) => one.contains(field)) !== scope) continue;
      const box = painted(field);
      if (box) looks.set(signature(box), [...(looks.get(signature(box)) ?? []), field]);
    }
    if (looks.size < 2) continue;
    const common = [...looks.entries()].sort((a, b) => b[1].length - a[1].length)[0]![0];
    for (const [look, members] of looks) if (look !== common) for (const member of members) push({ kind: "field-style", hard: true, where: describe(member), detail: `${look} (most fields here: ${common})` });
  }
  for (const box of inScope.filter((element) => element.matches("input[type=checkbox], input[type=radio]") && visible(element) && !readerOnly(element))) {
    if (getComputedStyle(box).appearance !== "none") push({ kind: "native-control", hard: true, where: describe(box), detail: "draws the browser's own checkbox instead of the app's" });
  }

  const controls = inScope.filter((element) => element.matches("button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=radio], [role=checkbox], [role=switch], [role=tab], [tabindex='0']")
    && visible(element) && !hiddenByAncestor(element) && !(element as HTMLButtonElement).disabled && !element.matches(rowsSelector));

  // 6. every control shows the keyboard where it is
  if (options.focus) {
    const look = (element: Element) => {
      const style = getComputedStyle(element);
      return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow, style.backgroundColor, style.backgroundImage, style.borderColor, style.textDecorationLine].join("|");
    };
    const previous = document.activeElement as HTMLElement | null;
    // the app draws its focus tint only while someone moves with the keyboard (src/lib/focus-nav.ts)
    const root = document.documentElement;
    const navigating = root.hasAttribute("data-focus-nav");
    root.setAttribute("data-focus-nav", "");
    for (const control of controls) {
      const target = control as HTMLElement;
      // a control focused on open (a dialog's close) is measured at rest first, or before and after would match
      if (document.activeElement === target) target.blur();
      const before = look(target);
      target.focus({ preventScroll: true });
      if (document.activeElement !== target) continue;
      const after = look(target);
      // a field wrapped by a styled box shows focus on the wrapper (focus-within)
      // focus-within on a wrapper, or a peer-focus look on what draws a screen-reader-only input
      const wrappers: Element[] = [];
      for (let node = target.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) wrappers.push(node);
      for (let node = target.nextElementSibling, depth = 0; node && depth < 2; node = node.nextElementSibling, depth++) wrappers.push(node, ...Array.from(node.children));
      const around = () => wrappers.map(look).join("#");
      const wrapperAfter = around();
      target.blur();
      const wrapperBefore = around();
      // a text field's caret is its cue (styles.css), so an unchanged text field is listed, not failed
      const typed = target.matches("input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=button], [type=submit]), textarea, [contenteditable=true]");
      if (before === after && wrapperBefore === wrapperAfter) push({ kind: "focus", hard: !typed, where: describe(target), detail: typed ? "shows only the caret with keyboard focus" : "looks the same with keyboard focus" });
    }
    if (!navigating) root.removeAttribute("data-focus-nav");
    previous?.focus?.({ preventScroll: true });
  }

  // 7. touch targets
  if (options.touch) {
    for (const control of controls) {
      if (control.matches("input[type=text], input[type=password], input[type=email], textarea, a[href]:not([role])") && control.closest(".chat-md, p")) continue;
      // a scroller that takes the keyboard only so its lines can be scrolled is no target a thumb presses
      if (control.matches("[tabindex='0']:not(button, a[href], input, textarea, select, [role])") && /auto|scroll/.test(getComputedStyle(control).overflowY + getComputedStyle(control).overflowX)) continue;
      // what a screen-reader-only input's label draws is what a thumb hits
      // a label takes the tap for the control it holds
      let hit: Element = control.closest("label") ?? (readerOnly(control) ? control.parentElement ?? control : control);
      // a small keyboard button inside a row that takes the tap itself (a pointer cursor across it)
      for (let node = hit.parentElement, depth = 0; node && depth < 2; node = node.parentElement, depth++) {
        const box = node.getBoundingClientRect();
        if (getComputedStyle(node).cursor === "pointer" && Math.min(box.width, box.height) >= 24) { hit = node; break; }
      }
      // a pseudo-element hit area (absolute, reaching past the box) counts as the target
      const box = hit.getBoundingClientRect();
      let rect = { width: box.width, height: box.height };
      for (const pseudo of ["::before", "::after"]) {
        const look = getComputedStyle(hit, pseudo);
        if (look.content === "none" || look.position !== "absolute") continue;
        const px = (value: string) => (value.endsWith("px") ? parseFloat(value) : 0);
        rect = { width: Math.max(rect.width, box.width - px(look.left) - px(look.right)), height: Math.max(rect.height, box.height - px(look.top) - px(look.bottom)) };
      }
      const size = Math.min(rect.width, rect.height);
      if (size < 24) push({ kind: "tap-target", hard: true, where: describe(control), detail: `${Math.round(rect.width)}x${Math.round(rect.height)}px, under 24px` });
      else if (size < 44) push({ kind: "tap-target", hard: false, where: describe(control), detail: `${Math.round(rect.width)}x${Math.round(rect.height)}px, under 44px` });
    }
  }

  // 8. text contrast against what is painted behind it
  const behind = (element: Element) => {
    let fill = { r: 255, g: 255, b: 255, a: 0 };
    const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      const color = parse(style.backgroundColor);
      if (color && color.a > 0) { layers.push(color); if (color.a >= 1) break; }
    }
    if (!layers.length) return null;
    fill = { ...layers.pop()!, a: 1 };
    for (const layer of layers.reverse()) fill = { r: layer.r * layer.a + fill.r * (1 - layer.a), g: layer.g * layer.a + fill.g * (1 - layer.a), b: layer.b * layer.a + fill.b * (1 - layer.a), a: 1 };
    return fill;
  };
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  for (const element of inScope) {
    if (!Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim())) continue;
    if (!visible(element) || hiddenByAncestor(element) || element.closest("pre, code, .shiki, [aria-disabled=true], :disabled, [data-gallery-allow-contrast]")) continue;
    const style = getComputedStyle(element);
    const ink = parse(style.color), paper = behind(element);
    if (!ink || !paper) continue;
    // a field drawn through a mirror (the composer's link pills) paints its own text clear on purpose; the mirror is checked
    if (ink.a === 0 && element.matches("textarea, input")) continue;
    const opacity = Number(style.opacity);
    const shown = { r: ink.r * ink.a * opacity + paper.r * (1 - ink.a * opacity), g: ink.g * ink.a * opacity + paper.g * (1 - ink.a * opacity), b: ink.b * ink.a * opacity + paper.b * (1 - ink.a * opacity) };
    const [hi, lo] = [luminance(shown), luminance(paper)].sort((a, b) => b - a);
    const ratio = (hi! + 0.05) / (lo! + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    const needed = large ? 3 : 4.5;
    if (ratio < 3) push({ kind: "contrast", hard: true, where: describe(element), detail: `${ratio.toFixed(2)}:1, under 3:1` });
    else if (ratio < needed) push({ kind: "contrast", hard: false, where: describe(element), detail: `${ratio.toFixed(2)}:1, under ${needed}:1` });
  }
  return issues;
}
