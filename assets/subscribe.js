// Progressive enhancement for the research subscription form.
// Without JS the form posts normally and the backend redirects to /<lang>/subscribed.html.
(function () {
  var form = document.getElementById("research-subscription");
  if (!form) return;
  var status = document.getElementById("subscription-status");
  var button = form.querySelector('button[type="submit"]');
  var messages = JSON.parse(form.getAttribute("data-messages") || "{}");
  var endpoint = form.getAttribute("action") || "";
  var loadedAt = Date.now();
  var busy = false;
  var fieldFor = { invalid_email: "email", name_required: "name", name_invalid: "name", consent_required: "consent" };
  var keyFor = { email: "invalid_email", name: "name_required", consent: "consent_required" };

  function show(key, isError) {
    if (!status) return;
    status.setAttribute("role", isError ? "alert" : "status");
    status.setAttribute("data-state", isError ? "error" : "ok");
    status.textContent = messages[key] || messages.error || "";
  }

  function markInvalid(name) {
    var field = form.elements[name];
    if (!field) return;
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", "subscription-status");
    field.focus();
  }

  form.addEventListener("input", function (event) {
    var field = event.target;
    if (field.getAttribute("aria-invalid")) {
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
    }
  });

  if (!/^https:\/\//.test(endpoint) || endpoint.indexOf("__") >= 0) {
    show("unconfigured", true);
    Array.prototype.forEach.call(form.querySelectorAll("input"), function (input) { input.disabled = true; });
    button.setAttribute("aria-disabled", "true");
    form.addEventListener("submit", function (event) { event.preventDefault(); });
    return;
  }

  // Native validation with the page's own wording instead of the browser bubble.
  form.addEventListener("invalid", function (event) {
    event.preventDefault();
    if (form.querySelector('[aria-invalid="true"]')) return;
    show(keyFor[event.target.name] || "error", true);
    markInvalid(event.target.name);
  }, true);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.setAttribute("aria-disabled", "true");
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    data.elapsed = String(Date.now() - loadedAt);
    show("sending", false);
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;
    // text/plain keeps the request "simple", so no CORS preflight reaches Apps Script.
    fetch(endpoint, { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "text/plain;charset=UTF-8" }, signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error("Subscription request failed (HTTP " + res.status + ")");
        return res.json();
      })
      .then(function (res) {
        if (res && res.ok) {
          form.reset();
          loadedAt = Date.now();
          show("check", false);
          status.setAttribute("tabindex", "-1");
          status.focus();
        } else {
          var key = res && res.error ? res.error : "error";
          show(key, true);
          if (fieldFor[key]) markInvalid(fieldFor[key]);
        }
      })
      .catch(function () { show("error", true); })
      .then(function () {
        if (timer) clearTimeout(timer);
        busy = false;
        button.removeAttribute("aria-disabled");
      });
  });
})();
