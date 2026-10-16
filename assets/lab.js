// Shared behavior for "lab" pages: the phone menu toggle and the footer year.
// Each page's <head> adds the "js" class to <html> so the menu starts collapsed without a flash.
(function () {
  var toggle = document.querySelector(".lab-menu-toggle");
  var nav = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (toggle && nav) {
    var setOpen = function (open) {
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  var year = document.getElementById("footer-year");
  if (year) year.textContent = new Date().getFullYear();
})();
