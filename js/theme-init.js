(function(){
  var t = localStorage.getItem("cf_theme") || "auto";
  document.documentElement.setAttribute("data-theme",
    t === "auto"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : t);
  document.documentElement.dataset.themePref = t;
})();
