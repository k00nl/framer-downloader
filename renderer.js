const $ = (id) => document.getElementById(id);

const urlInput = $("url");
const destInput = $("dest");
const pickBtn = $("pick");
const downloadBtn = $("download");
const status = $("status");
const log = $("log");
const progressCard = $("progress-card");
const discovered = $("discovered");
const bar = $("bar");

// ── Tabs ──
const tabBtns = document.querySelectorAll(".tab-btn");
function showTab(name) {
  tabBtns.forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle("border-gray-900", active);
    b.classList.toggle("text-gray-900", active);
    b.classList.toggle("border-transparent", !active);
    b.classList.toggle("text-gray-500", !active);
  });
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.panel !== name);
  });
  if (name === "sites") renderSites();
}
tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// Footer link opens in the system browser, not inside the app window.
$("footer-link").addEventListener("click", (e) => {
  e.preventDefault();
  window.api.openExternal("https://k00.nl");
});

$("marketplace-link").addEventListener("click", (e) => {
  e.preventDefault();
  window.api.openExternal("https://www.framer.com/marketplace/templates/");
});

// Status line: red + bold for errors, muted grey otherwise.
function setStatus(msg, isError) {
  status.textContent = msg;
  status.className = isError
    ? "text-sm font-medium text-red-600"
    : "text-sm text-gray-500";
}

// ── Confirm modal ──
const modal = $("modal");
let modalResolve = null;
const MODAL_VARIANTS = {
  danger:
    "rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700",
  primary:
    "rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800",
};
function showConfirm(title, body, confirmText = "Delete", variant = "danger") {
  $("modal-title").textContent = title;
  $("modal-body").textContent = body;
  const cb = $("modal-confirm");
  cb.textContent = confirmText;
  cb.className = MODAL_VARIANTS[variant] || MODAL_VARIANTS.danger;
  $("modal-cancel").classList.remove("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  return new Promise((res) => (modalResolve = res));
}
// OK-only notification (replaces native alert()).
function showAlert(title, body) {
  $("modal-title").textContent = title;
  $("modal-body").textContent = body;
  const cb = $("modal-confirm");
  cb.textContent = "OK";
  cb.className = MODAL_VARIANTS.primary;
  $("modal-cancel").classList.add("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  return new Promise((res) => (modalResolve = res));
}
function closeModal(result) {
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}
$("modal-cancel").addEventListener("click", () => closeModal(false));
$("modal-confirm").addEventListener("click", () => closeModal(true));
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal(false);
});

// ── Log ──
function addLog(msg, kind) {
  const line = document.createElement("div");
  line.textContent = msg;
  if (kind === "error") line.className = "text-red-500";
  else if (kind === "done") line.className = "text-green-600 font-medium";
  else if (kind === "info") line.className = "text-gray-400";
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ── Config prefill ──
window.api.getConfig().then((cfg) => {
  if (cfg.downloadPath) destInput.value = cfg.downloadPath;
  if (cfg.lastUrl) urlInput.value = cfg.lastUrl;
});

// ── Progress ──
function setBar(stats) {
  const total = stats.pagesEnqueued + stats.assetsEnqueued;
  const done = stats.pagesProcessed + stats.assetsProcessed;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  bar.style.width = pct + "%";
  discovered.textContent =
    `Pages ${stats.pagesProcessed}/${stats.pagesEnqueued} · ` +
    `Assets ${stats.assetsProcessed}/${stats.assetsEnqueued}` +
    (stats.failed ? ` · ${stats.failed} failed` : "");
}
function setCounters(s) {
  $("c-pages").textContent = s.pages;
  $("c-images").textContent = s.images;
  $("c-js").textContent = s.js;
  $("c-css").textContent = s.css;
  $("c-fonts").textContent = s.fonts;
  $("c-other").textContent = s.other + s.media;
}

window.api.onProgress((p) => {
  if (p.kind === "sitemap") {
    discovered.textContent = `Sitemap: ${p.count} pages found`;
  } else if (p.kind === "stats") {
    setBar(p.stats);
    setCounters(p.stats);
  } else if (p.msg) {
    addLog(p.msg, p.kind);
  }
  if (p.kind === "done") {
    bar.style.width = "100%";
    setRunning(false);
    renderSites();
  }
});

// ── Download ──
pickBtn.addEventListener("click", async () => {
  const folder = await window.api.pickFolder();
  if (folder) destInput.value = folder;
});

function setRunning(running) {
  downloadBtn.disabled = running;
  pickBtn.disabled = running;
  urlInput.disabled = running;
  downloadBtn.textContent = running ? "Downloading…" : "Download";
  urlInput.classList.toggle("opacity-60", running);
}

downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const destination = destInput.value.trim();

  if (!url) {
    setStatus("Enter a URL first.", true);
    urlInput.focus();
    return;
  }
  if (!destination) {
    setStatus("Choose a download location first.", true);
    pickBtn.focus();
    return;
  }

  // Ask before overwriting an existing download.
  let overwrite = false;
  const check = await window.api.checkSiteExists(url, destination);
  if (check.error) {
    setStatus(check.error, true);
    return;
  }
  if (check.exists) {
    const ok = await showConfirm(
      "Site already exists",
      `"${check.host}" has already been downloaded. Overwrite it? The existing folder is deleted and the site is downloaded again.`,
      "Overwrite",
      "primary"
    );
    if (!ok) {
      setStatus("Cancelled.");
      return;
    }
    overwrite = true;
  }

  setStatus("");
  log.textContent = "";
  progressCard.classList.remove("hidden");
  discovered.textContent = "Discovering pages…";
  bar.style.width = "0%";
  setCounters({ pages: 0, images: 0, js: 0, css: 0, fonts: 0, other: 0, media: 0 });
  setRunning(true);

  const res = await window.api.startDownload({ url, destination, overwrite });

  setRunning(false);
  if (!res.ok) {
    if (res.cancelled) setStatus("Cancelled.");
    else setStatus(res.error || "Failed.", true);
  } else {
    setStatus(`Done. Saved to ${res.name}. See the Sites tab.`);
  }
});

// ── Sites ──
async function renderSites() {
  const list = $("sites-list");
  const empty = $("sites-empty");
  const sites = await window.api.getSites();

  empty.classList.toggle("hidden", sites.length > 0);
  list.innerHTML = "";

  for (const s of sites) {
    const li = document.createElement("li");
    li.className = "flex items-center gap-3 px-4 py-3";

    const info = document.createElement("div");
    info.className = "min-w-0 flex-1";
    info.innerHTML =
      `<div class="truncate text-sm font-medium text-gray-900">${s.name}</div>` +
      (s.running
        ? `<div class="text-xs text-green-600">● serving at ${s.url}</div>`
        : s.exists
        ? `<div class="text-xs text-gray-400">not serving</div>`
        : `<div class="text-xs text-red-500">files missing, re-download</div>`);

    const portInput = document.createElement("input");
    portInput.type = "number";
    portInput.value = s.port;
    portInput.min = "1";
    portInput.max = "65535";
    portInput.className =
      "w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 outline-none focus:border-gray-900";
    portInput.addEventListener("change", async () => {
      const r = await window.api.setSitePort(s.name, portInput.value);
      if (!r.ok) {
        await showAlert("Could not change port", r.error);
        portInput.value = s.port;
      } else {
        renderSites();
      }
    });

    const serveBtn = document.createElement("button");
    serveBtn.className =
      "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50";
    serveBtn.textContent = s.running ? "Stop" : "Serve";
    serveBtn.disabled = !s.exists;
    serveBtn.addEventListener("click", async () => {
      serveBtn.disabled = true;
      const r = s.running
        ? await window.api.stopSite(s.name)
        : await window.api.serveSite(s.name);
      if (!r.ok) await showAlert("Something went wrong", r.error);
      renderSites();
    });

    const delBtn = document.createElement("button");
    delBtn.className =
      "rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      const ok = await showConfirm(
        `Delete ${s.name}?`,
        "This permanently removes the downloaded files for this site.",
        "Delete"
      );
      if (!ok) return;
      const r = await window.api.deleteSite(s.name);
      if (!r.ok) await showAlert("Could not delete", r.error);
      renderSites();
    });

    const folderBtn = document.createElement("button");
    folderBtn.title = "Open folder";
    folderBtn.className =
      "rounded-lg border border-gray-300 bg-white p-2 text-gray-600 transition hover:bg-gray-50 disabled:opacity-50";
    folderBtn.disabled = !s.exists;
    folderBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" class="h-4 w-4">' +
      '<path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>';
    folderBtn.addEventListener("click", async () => {
      const r = await window.api.openSiteFolder(s.name);
      if (!r.ok) await showAlert("Could not open folder", r.error);
    });

    li.append(info, portInput, folderBtn, serveBtn, delBtn);
    list.appendChild(li);
  }
}
