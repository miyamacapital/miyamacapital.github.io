// Homepages and the research archive read the same article catalog.
// Saved cards remain available when JavaScript or the catalog is unavailable.
(function () {
  var container = document.querySelector("[data-lab-research]");
  if (!container) return;

  var language = container.getAttribute("data-lab-research");

  function isArticle(article) {
    if (!article || article.lang !== language ||
        typeof article.id !== "string" || typeof article.title !== "string" || typeof article.summary !== "string" ||
        typeof article.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(article.date)) return false;
    try {
      return new URL(article.url).protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  function makeCard(article) {
    var card = document.createElement("article");
    card.className = "bg-lab-card border border-lab-line rounded-lab-card";
    card.style.cssText = "min-width:0;padding:20px;display:flex;flex-direction:column;gap:6px";

    var date = document.createElement("p");
    date.className = "font-lab-mono text-lab-muted";
    date.style.cssText = "margin:0;font-size:12px";
    date.textContent = article.date;

    var heading = document.createElement("h3");
    heading.style.cssText = "margin:0;font-size:18px;font-weight:700;line-height:1.45";
    var link = document.createElement("a");
    link.className = "lab-tap text-lab-text";
    link.style.textDecoration = "none";
    link.href = article.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    var title = document.createElement("span");
    title.textContent = article.title;
    link.appendChild(title);
    heading.appendChild(link);

    var summary = document.createElement("p");
    summary.className = "text-lab-body";
    summary.style.cssText = "margin:0;font-size:14px";
    summary.textContent = article.summary;

    card.append(date, heading, summary);
    return card;
  }

  fetch("/data/articles.json", { cache: "no-cache" })
    .then(function (response) {
      if (!response.ok) throw new Error("Article catalog returned " + response.status);
      return response.json();
    })
    .then(function (articles) {
      if (!Array.isArray(articles)) throw new Error("Article catalog must be an array");
      var latest = articles.filter(isArticle).sort(function (a, b) {
        return b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
      }).slice(0, 3);
      if (!latest.length) return;

      var cards = document.createDocumentFragment();
      latest.forEach(function (article) { cards.appendChild(makeCard(article)); });
      container.replaceChildren(cards);
    })
    .catch(function (error) {
      console.warn("Latest research could not be refreshed; saved cards remain available.", error);
    });
})();
