export const MOBILE_MAX_WIDTH = 640;
export const SPLIT_PANEL_MIN_WIDTH = 960;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;

// Polyforge dock (pi#117): default 460, resizable within [340, 90vw]. The
// static cap only bounds aria-valuemax before mount — the live max is 90vw
// (getPolyforgeDockMaxWidth); 6912 is 90vw at 8K (7680px), so it never binds
// tighter than 90vw on any narrower viewport.
export const POLYFORGE_DOCK_DEFAULT_WIDTH = 460;
export const POLYFORGE_DOCK_MIN_WIDTH = 340;
export const POLYFORGE_DOCK_MAX_WIDTH = 6912;

export function getPolyforgeDockMaxWidth(viewportWidth: number): number {
  return Math.round(viewportWidth * 0.9);
}

// Mobile sheet heights (pi#120): the bottom sheets (Polyforge, bg-tasks)
// open at 62% of their container and resize by dragging the top edge,
// clamped to [30%, 90%]. The dragged height persists as an integer
// percentage; an absent, unparsable or out-of-range stored value reads as
// the 62% default (the same convention as the pi#117 dock width).
export const SHEET_DEFAULT_HEIGHT_PCT = 62;
export const SHEET_MIN_HEIGHT_PCT = 30;
export const SHEET_MAX_HEIGHT_PCT = 90;

/** Clamp a sheet height percentage to [30, 90]; non-finite reads as the 62
 *  default (an invalid drag or stored value never collapses the sheet). */
export function clampSheetHeightPct(pct: number): number {
  const finite = Number.isFinite(pct) ? pct : SHEET_DEFAULT_HEIGHT_PCT;
  return Math.min(SHEET_MAX_HEIGHT_PCT, Math.max(SHEET_MIN_HEIGHT_PCT, Math.round(finite)));
}

/** Parse a stored sheet height percentage: null when absent, unparsable or
 *  out of range — the caller then reads the 62% default. */
export function parseStoredSheetHeightPct(stored: string | null): number | null {
  if (stored === null) return null;
  const parsed = Number.parseFloat(stored);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < SHEET_MIN_HEIGHT_PCT || parsed > SHEET_MAX_HEIGHT_PCT) return null;
  return Math.round(parsed);
}

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 420;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.42, 360, 640);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const chatWidth = compact ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  return Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - chatWidth - visibleRightPanelWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_MAX_WIDTH;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    viewportWidth - DESKTOP_CHAT_MIN_WIDTH - visibleSidebarWidth,
  );
}
