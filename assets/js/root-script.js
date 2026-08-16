(function() {

  // Theme toggle
  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    var icon = toggle.querySelector(".theme-toggle-icon");
    var html = document.documentElement;

    function updateToggle(theme) {
      var isDark = theme === "dark";
      toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
      if (icon) {
        if (isDark) {
          // Sun icon for dark mode (switch to light)
          icon.innerHTML = '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
        } else {
          // Moon icon for light mode (switch to dark)
          icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
        }
      }
    }

    updateToggle(html.getAttribute("data-theme") || "light");

    toggle.addEventListener("click", function() {
      var current = html.getAttribute("data-theme") || "light";
      var next = current === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      updateToggle(next);
    });
  }
})();
