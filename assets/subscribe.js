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
  var langField = form.elements.namedItem("lang");
  var lang = (langField && langField.value) || document.documentElement.lang || "";

  // GA4 funnel events (gtag is defined inline in <head>; events queue in dataLayer until the library loads).
  // Only the page language and an error key are sent, never anything the visitor typed.
  function track(name, params) {
    if (typeof gtag !== "function") return;
    var payload = { lang: lang };
    for (var key in params) if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
    try { gtag("event", name, payload); } catch (ignore) {}
  }

  function show(key, state) {
    if (!status) return;
    status.setAttribute("role", state === "error" ? "alert" : "status");
    status.setAttribute("data-state", state);
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

  // Until the backend is deployed, the section shows a calm notice and the platform links only.
  if (!/^https:\/\//.test(endpoint) || endpoint.indexOf("__") >= 0) {
    Array.prototype.forEach.call(form.querySelectorAll(".lab-field, .lab-consent, button"), function (el) { el.hidden = true; });
    show("unconfigured", "muted");
    track("subscribe_unconfigured");
    form.addEventListener("submit", function (event) { event.preventDefault(); });
    return;
  }

  // Native validation with the page's own wording instead of the browser bubble.
  form.addEventListener("invalid", function (event) {
    event.preventDefault();
    if (form.querySelector('[aria-invalid="true"]')) return;
    show(keyFor[event.target.name] || "error", "error");
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
    show("sending", "ok");
    track("subscribe_submit");
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;
    // text/plain keeps the request "simple", so no CORS preflight reaches Apps Script.
    fetch(endpoint, { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "text/plain;charset=UTF-8" }, signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) {
          var failure = new Error("Subscription request failed (HTTP " + res.status + ")");
          failure.key = "http_" + res.status;
          throw failure;
        }
        return res.json();
      })
      .then(function (res) {
        if (res && res.ok) {
          form.reset();
          loadedAt = Date.now();
          show("check", "ok");
          status.setAttribute("tabindex", "-1");
          status.focus();
          track("subscribe_success");
        } else {
          var key = res && res.error ? String(res.error) : "error";
          show(key, "error");
          if (fieldFor[key]) markInvalid(fieldFor[key]);
          track("subscribe_error", { error: key });
        }
      })
      .catch(function (err) {
        show("error", "error");
        track("subscribe_error", { error: (err && err.key) || (err && err.name === "AbortError" ? "timeout" : "network") });
      })
      .then(function () {
        if (timer) clearTimeout(timer);
        busy = false;
        button.removeAttribute("aria-disabled");
      });
  });
})();
