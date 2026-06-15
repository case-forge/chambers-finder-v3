(function () {
  var KEY = "cf_theme";
  function apply(pref) {
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", pref === "auto" ? (dark ? "dark" : "light") : pref);
    document.documentElement.dataset.themePref = pref;
    document.querySelectorAll(".theme-btn").forEach(function (b) {
      var active = b.dataset.t === pref;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
  }
  apply(localStorage.getItem(KEY) || "auto");
  document.querySelectorAll(".theme-btn").forEach(function (b) {
    b.addEventListener("click", function () { localStorage.setItem(KEY, b.dataset.t); apply(b.dataset.t); });
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if ((localStorage.getItem(KEY) || "auto") === "auto") apply("auto");
  });
})();
