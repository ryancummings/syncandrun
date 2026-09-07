/*
 * Applies the stored theme before first paint so the console never flashes the
 * wrong surface. This script is the sole authority on the root class; React
 * only ever writes through the same storage key.
 */
(function applyStoredTheme() {
  var root = document.documentElement;
  var stored = null;
  try {
    stored = window.localStorage.getItem("syncandrun.theme");
  } catch (error) {
    stored = null;
  }
  root.classList.add(stored === "light" ? "light" : "dark");
})();
