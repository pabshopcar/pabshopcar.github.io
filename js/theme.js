// Runs in <head> so the theme and photo style apply before the first paint. Black is the default.
// A visitor's own choice wins (js/site.js saves it when they press the switch), and ?theme=black|plate
// or ?photos=fit|pop in the address wins for that page.
//
// The keys end in 2 on purpose: the old code saved whatever it picked on every first visit, so
// everyone who ever opened the site carries the old light default. A new key lets the new default
// through and still remembers a real choice.
(function () {
  var root = document.documentElement;
  function pick(param, key, allowed, fallback) {
    var value;
    try {
      value = new URLSearchParams(location.search).get(param) || localStorage.getItem(key);
    } catch (e) {}
    return allowed.indexOf(value) < 0 ? fallback : value;
  }
  root.setAttribute("data-theme", pick("theme", "pab-theme2", ["plate", "black"], "black"));
  root.setAttribute("data-photos", pick("photos", "pab-photos2", ["fit", "pop"], "fit"));
})();
