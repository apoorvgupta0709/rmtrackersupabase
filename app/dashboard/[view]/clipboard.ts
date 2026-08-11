"use client";

/**
 * Putting text on the clipboard.
 *
 * It lives in its own module because both the table and the drill-down modal copy, and
 * having either import the other would put a cycle between two client components.
 */

/** Clipboard, with the fallback for a page served over plain http. */
export async function writeClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}
