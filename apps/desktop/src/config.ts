// Links and features that depend on things that do not exist yet. A null URL hides its button, so the
// app never shows a link to a page that is not published.

export const config = {
  /** Web burning guide (Phase 6: MP4 to IFO website). */
  burnGuideUrl: null as string | null,
  /** GitHub Issues of the public repository. */
  reportIssueUrl: null as string | null,
  /**
   * Tauri updater: needs a signed update feed (GitHub Releases) and a public key. Until then "Check
   * for Updates" only explains that it is unavailable. See docs/desktop.md.
   */
  updatesEnabled: false,
};
