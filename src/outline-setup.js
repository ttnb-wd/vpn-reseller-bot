// Official Outline Client destinations. Never append customer access URLs.
const OUTLINE_DOWNLOADS = Object.freeze({
  ios: "https://apps.apple.com/us/app/outline-app/id1356177741",
  android: "https://play.google.com/store/apps/details?id=org.outline.android.client",
  desktop: "https://getoutline.org/get-started/#step-3",
});

// Standard browser signals only; an unknown environment uses the general page.
// Kept self-contained so the private setup page can inline it under its CSP.
function outlinePlatform(environment = {}) {
  const ua = environment.userAgent || "";
  const platform = environment.platform || "";
  if (/iPhone|iPad|iPod/i.test(ua) ||
      (platform === "MacIntel" && environment.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua + platform)) return "windows";
  if (/Mac/i.test(ua + platform)) return "macos";
  return "desktop";
}

module.exports = { OUTLINE_DOWNLOADS, outlinePlatform };
