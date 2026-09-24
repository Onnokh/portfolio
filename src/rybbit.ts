/**
 * Rybbit, the visitor count, as on shadertown and sleevy.
 *
 * The site ID is fixed at build time (VITE_RYBBIT_SITE_ID, in .env.production). With no site ID the
 * count stays off, because a default one would send the page views to whichever site holds that
 * ID. The dev server is off too, and so is a build served on this machine, such as `npm run perf`:
 * local work should not move the numbers.
 *
 * Rybbit sets no cookies, follows no person between sites and builds no profile, so none of this
 * hangs on a consent choice.
 */

const SCRIPT_ID = "rybbit-analytics";
const SITE_ID: string | undefined = import.meta.env.VITE_RYBBIT_SITE_ID;
const SCRIPT_SRC: string = import.meta.env.VITE_RYBBIT_SCRIPT_SRC ?? "https://rybbit.missingmounts.com/api/script.js";

const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/** Puts the Rybbit tag in the page, once. */
export function loadRybbit() {
  if (import.meta.env.DEV || local || !SITE_ID) return;
  if (document.getElementById(SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = SCRIPT_SRC;
  script.dataset.siteId = SITE_ID;
  script.defer = true;
  // No `crossOrigin`: it makes this a CORS request, and /api/script.js answers with no
  // Access-Control-Allow-Origin, so the browser drops the script.
  document.head.appendChild(script);
}
