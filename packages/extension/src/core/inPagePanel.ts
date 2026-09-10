import { browser } from "wxt/browser";
import type { ExtensionSettings, Platform, SchedulerState } from "@lurkloot/shared/models";

// Stage 1 of the in-page panel: an icon button in the site's own top-right nav,
// and a draggable window hosting the panel document (entrypoints/inpagePanel),
// loaded on first open.
//
// This module must stay dependency-free. WXT builds content scripts as a single
// IIFE bundle (`formats: ["iife"]` in getLibModeConfig), which forces Rollup's
// inlineDynamicImports, so anything imported here — React, @lurkloot/popup-ui,
// Tailwind — ships on every twitch.tv and kick.com page load whether or not the
// panel is ever opened. Rendering the popup in the content script cost 1.2 MB
// per platform; behind the iframe this bundle stays in single-digit kilobytes.
// Everything here is styled with hand-written CSS for the same reason.

const BUTTON_ID = "lurkloot-nav-button";
const IDLE_BACKGROUND = "rgba(128,128,128,.22)";
const HOVER_BACKGROUND = "rgba(128,128,128,.34)";

// The window chrome is drawn here, outside the iframe, so it cannot pick up the
// panel's own theming and has to resolve its colours itself. It follows
// prefers-color-scheme rather than the host site's theme, because what it
// frames is the popup, and the popup's stylesheet sets `color-scheme: light
// dark` — matching Twitch instead would leave a light title bar bolted to a
// dark popup for anyone whose site theme and OS theme disagree.
const CHROME_SURFACE = "light-dark(#f7f7f8, #0e0e10)";
const CHROME_TEXT = "light-dark(#18181b, #efeff1)";
const CHROME_MUTED = "light-dark(#53535f, #adadb8)";
const CHROME_HOVER = "light-dark(rgba(0,0,0,.08), rgba(255,255,255,.12))";
const PANEL_SURFACE = "light-dark(#ffffff, #18181b)";
const PANEL_ID = "lurkloot-panel";
const SETTINGS_KEY = "settings";
const STATE_KEY = "schedulerState";
const UI_STATE_KEY = "inPagePanelUi";

// The panel document renders <Popup>, whose root is h-[600px] w-[400px]. The
// frame is sized to match exactly: anything smaller reintroduces a scrollbar,
// which steals width from the 400px the popup insists on and makes it overflow
// horizontally.
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 600;
const TITLEBAR_HEIGHT = 32;
const EDGE_MARGIN = 16;

// Where the button goes on each site, most specific first.
//
// These deliberately avoid the generated class names sitting right beside them
// — Twitch's `Layout-sc-1xcs6mc-0`, Kick's `z-[402]` — because those are build
// output. Kick proved the point during development: its nav class went from
// `z-navbar` to `z-[402]` between two page loads on the same afternoon, so a
// selector keyed on that would already be dead. `--navbar-height` survives both
// spellings Kick emits (`h-[var(--navbar-height)]` and `h-(--navbar-height)`).
interface Anchor {
  find(): Element | null | undefined;
  place: "before" | "append" | "prepend";
}

const ANCHORS: Record<Platform, Anchor[]> = {
  twitch: [
    // Immediately left of the Prime crown, inside the icon cluster.
    { find: () => document.querySelector(".top-nav__prime"), place: "before" },
    { find: () => document.querySelector(".top-nav__menu"), place: "append" },
  ],
  kick: [
    // Kick's nav carries no semantic hooks, so this keys off the layout
    // variable and takes the bar's right-hand cluster.
    { find: () => document.querySelector('nav[class*="navbar-height"]')?.lastElementChild, place: "prepend" },
  ],
};

// Matched to each site's own nav buttons, measured against the live pages.
const BUTTON_METRICS: Record<Platform, { height: number; radius: number; padding: number }> = {
  twitch: { height: 30, radius: 4, padding: 12 },
  kick: { height: 36, radius: 6, padding: 14 },
};

// The Lurkloot mark as a monochrome glyph. Drawn inline (not the packaged
// logo-ring.svg) for two reasons: referencing the file from a content script
// would mean making it a second web-accessible resource, and the nav's other
// icons are single-colour, so the gradient logo would look pasted on.
// currentColor lets it inherit the site's own nav foreground.
const ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true" focusable="false">
  <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-opacity="0.35" stroke-width="2.5"/>
  <path d="M12 3.5 A8.5 8.5 0 1 1 5.05 16.9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M10.4 9.1 a0.7 0.7 0 0 1 1.05-0.6 l3.6 2.3 a0.7 0.7 0 0 1 0 1.2 l-3.6 2.3 a0.7 0.7 0 0 1-1.05-0.6 z" fill="currentColor"/>
</svg>`;

interface PanelUiState {
  left?: number;
  top?: number;
  open?: boolean;
}

let platform: Platform;
let button: HTMLButtonElement | undefined;
let panel: HTMLDivElement | undefined;
let frame: HTMLIFrameElement | undefined;
let anchorObserver: MutationObserver | undefined;
let ownTabId: number | undefined;
let enabled = false;

export function mountInPagePanel(forPlatform: Platform): void {
  platform = forPlatform;
  void start();
}

async function start(): Promise<void> {
  // Asked once. A content script cannot read its own tab id, and the id is
  // stable for the document's lifetime, so everything downstream re-evaluates
  // from persisted state rather than re-asking.
  ownTabId = await browser.runtime.sendMessage({ type: "getTabId" }).catch(() => undefined) as number | undefined;

  await reconcile();

  // Both inputs live in storage.local, so watching it covers the settings
  // toggle and the scheduler claiming this tab, with no polling and no second
  // round-trip.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (SETTINGS_KEY in changes || STATE_KEY in changes) void reconcile();
  });

  // Twitch and Kick both put the player into the Fullscreen API. A floating
  // panel over fullscreen video is intrusive, and on Twitch it is drawn above
  // the player controls.
  document.addEventListener("fullscreenchange", applyVisibility);
  window.addEventListener("resize", clampIntoViewport);
}

async function reconcile(): Promise<void> {
  const stored = await browser.storage.local.get([SETTINGS_KEY, STATE_KEY]);
  const settings = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  const state = stored[STATE_KEY] as Partial<SchedulerState> | undefined;

  enabled = settings?.showInPagePanel === true && !isManagedTab(state);
  if (!enabled) {
    teardown();
    return;
  }
  ensureButton();
  watchAnchor();
  if ((await readUi())?.open) await openPanel();
}

// The extension opens its own muted twitch.tv/kick.com tabs to farm in, and
// content scripts run there like anywhere else. Showing the button inside one
// would be noise at best, and it would invite the user to interact with a tab
// the scheduler owns and may close.
function isManagedTab(state: Partial<SchedulerState> | undefined): boolean {
  if (ownTabId === undefined || !state) return false;
  return [
    ...Object.values(state.managedWatchTabs ?? {}),
    ...Object.values(state.managedPageContextTabs ?? {}),
  ].some((tab) => tab?.tabId === ownTabId);
}

function teardown(): void {
  anchorObserver?.disconnect();
  anchorObserver = undefined;
  button?.remove();
  button = undefined;
  closePanel();
  panel?.remove();
  panel = undefined;
  frame = undefined;
}

/* -------------------------------------------------------------- nav button */

function ensureButton(): void {
  if (button?.isConnected) return;

  button ??= createButton();
  const target = resolveAnchor();
  if (!target) {
    // No anchor matched, so the site reorganized its nav. Show nothing.
    //
    // An earlier revision fell back to a floating corner button so the feature
    // could not silently disappear. That was right while this was opt-in, and
    // wrong now that it ships on: a single Twitch nav change would put an
    // unexpected floating control on every user's screen at once, which is a
    // worse outcome than the absence it guards against. The toolbar popup still
    // works, so absence degrades rather than breaks.
    warnOnce("could not find a place in the page nav for the Lurkloot button; the toolbar popup still works");
    return;
  }
  if (target.place === "before") target.element.parentElement?.insertBefore(button, target.element);
  else if (target.place === "prepend") target.element.prepend(button);
  else target.element.append(button);
}

// The page console is where someone debugging a missing button would look.
// There is no diagnostic channel from a content script into the activity log,
// and adding one would cost more plumbing than this failure is worth.
let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[Lurkloot] ${message}`);
}

function resolveAnchor(): { element: Element; place: Anchor["place"] } | undefined {
  for (const candidate of ANCHORS[platform] ?? []) {
    const element = candidate.find();
    if (element) return { element, place: candidate.place };
  }
  return undefined;
}

function createButton(): HTMLButtonElement {
  const metrics = BUTTON_METRICS[platform];
  const el = document.createElement("button");
  el.id = BUTTON_ID;
  el.type = "button";
  el.innerHTML = `${ICON}<span>Lurkloot</span>`;
  // The visible text is the accessible name, so no aria-label: adding one would
  // override what the user can actually read. Neither string is localized —
  // this module is dependency-free by design and cannot reach the locale
  // catalogs without pulling the popup bundle into every page load.
  el.title = "Open Lurkloot";
  el.setAttribute("aria-expanded", "false");
  el.style.cssText = [
    "all:unset",
    "box-sizing:border-box",
    "cursor:pointer",
    "display:inline-flex",
    "align-items:center",
    "gap:6px",
    "flex:0 0 auto",
    "white-space:nowrap",
    `height:${metrics.height}px`,
    `padding:0 ${metrics.padding}px`,
    `border-radius:${metrics.radius}px`,
    "font-weight:600",
    "font-size:13px",
    "line-height:1",
    // A neutral mid-grey rather than either site's surface colour, with the
    // text left to inherit the nav's own foreground. That pairing survives a
    // theme flip in both directions: near-white text and near-black text are
    // both legible against mid-grey, so the button does not need to know
    // whether Twitch is in its dark or light theme.
    `background:${IDLE_BACKGROUND}`,
    "color:inherit",
  ].join(";");
  el.addEventListener("mouseenter", () => { el.style.background = HOVER_BACKGROUND; });
  el.addEventListener("mouseleave", () => { el.style.background = IDLE_BACKGROUND; });
  el.addEventListener("click", () => { void togglePanel(); });
  return el;
}

// Twitch and Kick are both client-rendered: navigating re-renders the nav and
// drops anything inserted into it. Re-inserting on mutation is what keeps the
// button alive across route changes without polling.
function watchAnchor(): void {
  anchorObserver?.disconnect();
  anchorObserver = new MutationObserver(() => {
    if (enabled && !button?.isConnected) ensureButton();
  });
  anchorObserver.observe(document.body, { childList: true, subtree: true });
}

/* ------------------------------------------------------------ panel window */

async function togglePanel(): Promise<void> {
  if (panel) closePanel();
  else await openPanel();
  await saveUi({ open: Boolean(panel) });
}

async function openPanel(): Promise<void> {
  if (panel) return;
  const ui = await readUi();

  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    `width:${PANEL_WIDTH}px`,
    "border-radius:12px",
    "overflow:hidden",
    "box-shadow:0 16px 48px rgba(0,0,0,.45)",
    // Required for light-dark() below to resolve at all.
    "color-scheme:light dark",
    `background:${PANEL_SURFACE}`,
  ].join(";");

  const titlebar = document.createElement("div");
  titlebar.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    `height:${TITLEBAR_HEIGHT}px`,
    "padding:0 6px 0 12px",
    "cursor:grab",
    `background:${CHROME_SURFACE}`,
    `color:${CHROME_TEXT}`,
    "font:600 12px/1 system-ui,sans-serif",
    "user-select:none",
  ].join(";");

  const title = document.createElement("span");
  title.textContent = "Lurkloot";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  close.style.cssText = [
    "all:unset",
    "cursor:pointer",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:24px",
    "height:24px",
    "border-radius:6px",
    "font:400 18px/1 system-ui,sans-serif",
    `color:${CHROME_MUTED}`,
  ].join(";");
  close.addEventListener("mouseenter", () => { close.style.background = CHROME_HOVER; });
  close.addEventListener("mouseleave", () => { close.style.background = ""; });
  close.addEventListener("click", () => { void togglePanel(); });
  titlebar.append(title, close);

  // `src` is assigned here rather than at page load: this is the point where
  // the user has actually asked for the panel, and it is what keeps the popup
  // bundle off every page view.
  frame = document.createElement("iframe");
  frame.title = "Lurkloot";
  frame.src = browser.runtime.getURL("/inpagePanel.html");
  frame.style.cssText = [
    `width:${PANEL_WIDTH}px`,
    `height:${PANEL_HEIGHT}px`,
    "border:0",
    "display:block",
    "color-scheme:normal",
  ].join(";");

  panel.append(titlebar, frame);
  document.body.append(panel);

  position(ui?.left, ui?.top);
  makeDraggable(titlebar);
  applyVisibility();
  button?.setAttribute("aria-expanded", "true");
}

function closePanel(): void {
  panel?.remove();
  panel = undefined;
  frame = undefined;
  button?.setAttribute("aria-expanded", "false");
}

function applyVisibility(): void {
  const hidden = Boolean(document.fullscreenElement);
  if (panel) panel.style.display = hidden ? "none" : "";
  if (button) button.style.visibility = hidden ? "hidden" : "";
}

function position(left: number | undefined, top: number | undefined): void {
  if (!panel) return;
  if (left === undefined || top === undefined) {
    // Opens under the top-right nav, near the button that summoned it.
    panel.style.right = `${EDGE_MARGIN}px`;
    panel.style.top = `${EDGE_MARGIN + 40}px`;
    return;
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  clampIntoViewport();
}

// A stored position can land off-screen after a resize or a monitor change.
function clampIntoViewport(): void {
  if (!panel || !panel.style.left) return;
  const rect = panel.getBoundingClientRect();
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN);
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN);
  panel.style.left = `${Math.min(Math.max(EDGE_MARGIN, rect.left), maxLeft)}px`;
  panel.style.top = `${Math.min(Math.max(EDGE_MARGIN, rect.top), maxTop)}px`;
}

function makeDraggable(handle: HTMLElement): void {
  let origin: { x: number; y: number; left: number; top: number } | undefined;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !panel) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = panel.getBoundingClientRect();
    origin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId);
    handle.style.cursor = "grabbing";
    // The iframe must not swallow the pointer stream the moment the cursor
    // crosses over it; pointer events inside a frame never reach this document.
    if (frame) frame.style.pointerEvents = "none";
    // Anchor to left/top for the whole drag, so the right/top default does not
    // fight the coordinates being written.
    panel.style.right = "";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
  });

  handle.addEventListener("pointermove", (event) => {
    if (!origin || !panel) return;
    panel.style.left = `${origin.left + event.clientX - origin.x}px`;
    panel.style.top = `${origin.top + event.clientY - origin.y}px`;
  });

  const end = (event: PointerEvent) => {
    if (!origin || !panel) return;
    origin = undefined;
    handle.releasePointerCapture(event.pointerId);
    handle.style.cursor = "grab";
    if (frame) frame.style.pointerEvents = "";
    clampIntoViewport();
    void saveUi({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) });
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/* ------------------------------------------------------------- persistence */

async function readUi(): Promise<PanelUiState | undefined> {
  return (await browser.storage.local.get(UI_STATE_KEY))[UI_STATE_KEY] as PanelUiState | undefined;
}

async function saveUi(patch: PanelUiState): Promise<void> {
  await browser.storage.local.set({ [UI_STATE_KEY]: { ...await readUi(), ...patch } });
}
