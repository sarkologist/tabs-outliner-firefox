const SAFE_BROWSER_CREATE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

const ABOUT_BLANK_URL = "about:blank";
const ABOUT_NEWTAB_URL = "about:newtab";

export function normalizeBrowserCreateUrl(url: string | undefined): string {
  return normalizeRestorableBrowserCreateUrl(url) ?? ABOUT_BLANK_URL;
}

export function normalizeRestorableBrowserCreateUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) {
    return ABOUT_BLANK_URL;
  }

  const lowerUrl = trimmed.toLocaleLowerCase();
  if (lowerUrl === ABOUT_BLANK_URL || lowerUrl === ABOUT_NEWTAB_URL) {
    return lowerUrl;
  }

  try {
    const parsed = new URL(trimmed);
    if (SAFE_BROWSER_CREATE_PROTOCOLS.has(parsed.protocol)) {
      return parsed.href;
    }
  } catch {
    return ABOUT_BLANK_URL;
  }

  return undefined;
}
