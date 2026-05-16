const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { Downloader } = require("./downloader");
const { renderPage } = require("./page-renderer");
const { serve } = require("./server");

let mainWindow = null;
const servers = new Map(); // site name -> { close, url, port }
const DEFAULT_PORT = 5432;

// Robust recursive delete for Windows: clears read-only attributes and
// retries through transient locks (antivirus, search indexer).
async function removeDir(target) {
  if (!fs.existsSync(target)) return;
  // Make everything writable first so rmdir is not denied (EPERM).
  const chmodAll = async (p) => {
    let st;
    try {
      st = await fs.promises.lstat(p);
    } catch {
      return;
    }
    await fs.promises.chmod(p, 0o666).catch(() => {});
    if (st.isDirectory()) {
      const entries = await fs.promises.readdir(p).catch(() => []);
      for (const e of entries) await chmodAll(path.join(p, e));
    }
  };
  await chmodAll(target);
  await fs.promises.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 300,
  });
}

function getSites() {
  return loadConfig().sites || [];
}

function saveSites(sites) {
  saveConfig({ sites });
}

// Add/update a site entry, keeping its existing port if it had one.
function upsertSite(name, root) {
  const sites = getSites();
  const existing = sites.find((s) => s.name === name);
  if (existing) {
    existing.root = root;
  } else {
    const used = new Set(sites.map((s) => s.port));
    let port = DEFAULT_PORT;
    while (used.has(port)) port++;
    sites.push({ name, root, port });
  }
  saveSites(sites);
}

function sitesWithState() {
  return getSites().map((s) => ({
    ...s,
    running: servers.has(s.name),
    url: servers.get(s.name)?.url || null,
    exists: fs.existsSync(s.root),
  }));
}

// ── Config persistence (remembers the download folder) ──
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error("[config] save failed:", e.message);
  }
  return next;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: "Framer Downloader",
    icon: path.join(__dirname, "media", "logo.png"),
    backgroundColor: "#ffffff",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#374151",
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Only one instance: a second launch focuses the existing window instead
// of starting a rival process that fights over the disk/GPU cache.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── IPC ──

ipcMain.handle("get-config", () => {
  const cfg = loadConfig();
  return {
    downloadPath: cfg.downloadPath || "",
    lastUrl: cfg.lastUrl || "https://site.framer.website/",
  };
});

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose download location",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: loadConfig().downloadPath || undefined,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  saveConfig({ downloadPath: chosen });
  return chosen;
});

// Mirrors Downloader's folder naming so we can detect an existing site.
function resolveTarget(url, destination) {
  let normalizedUrl = (url || "").trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = "https://" + normalizedUrl;
  let host;
  try {
    host = new URL(normalizedUrl).hostname;
  } catch {
    return { error: "Invalid URL." };
  }
  const folderName = host.replace(/[<>:"\\|?* -]/g, "_");
  const targetRoot = path.join(destination || "", folderName);
  const existing = getSites().find((s) => s.name === host);
  const exists = !!existing || (!!destination && fs.existsSync(targetRoot));
  return { normalizedUrl, host, targetRoot, existing, exists };
}

ipcMain.handle("check-site-exists", (_e, { url, destination }) => {
  const t = resolveTarget(url, destination);
  if (t.error) return { error: t.error };
  return { exists: t.exists, host: t.host };
});

ipcMain.handle("start-download", async (event, { url, destination, overwrite }) => {
  const t = resolveTarget(url, destination);
  if (t.error) return { ok: false, error: t.error };
  const { normalizedUrl, host, targetRoot, existing, exists } = t;

  saveConfig({ downloadPath: destination, lastUrl: url });

  if (exists) {
    if (!overwrite) return { ok: false, cancelled: true };
    if (servers.has(host)) {
      await servers.get(host).close().catch(() => {});
      servers.delete(host);
    }
    await removeDir(existing ? existing.root : targetRoot).catch(() => {});
  }

  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send("download-progress", payload);
  };

  try {
    // Render mode is disabled in the UI for now; renderPage stays available
    // for when it is re-enabled.
    const dl = new Downloader(normalizedUrl, destination, send, {
      renderPage: null,
    });
    const res = await dl.run();
    if (res.ok) upsertSite(res.name, res.siteRoot);
    return res;
  } catch (e) {
    send({ kind: "error", msg: `Fatal: ${e.message}` });
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("get-sites", () => sitesWithState());

ipcMain.handle("set-site-port", async (_e, { name, port }) => {
  port = parseInt(port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "Port must be between 1 and 65535." };
  }
  const sites = getSites();
  const site = sites.find((s) => s.name === name);
  if (!site) return { ok: false, error: "Unknown site." };
  site.port = port;
  saveSites(sites);
  // If it's currently serving, restart on the new port.
  if (servers.has(name)) {
    await servers.get(name).close().catch(() => {});
    servers.delete(name);
    return startServer(name);
  }
  return { ok: true };
});

async function startServer(name) {
  const site = getSites().find((s) => s.name === name);
  if (!site) return { ok: false, error: "Unknown site." };
  if (!fs.existsSync(site.root)) {
    return { ok: false, error: "Folder is gone, re-download it." };
  }
  if (servers.has(name)) return { ok: true, url: servers.get(name).url };
  try {
    const s = await serve(site.root, site.port);
    servers.set(name, s);
    return { ok: true, url: s.url };
  } catch (e) {
    const msg =
      e.code === "EADDRINUSE"
        ? `Port ${site.port} is already in use.`
        : e.message;
    return { ok: false, error: msg };
  }
}

ipcMain.handle("serve-site", async (_e, name) => {
  const res = await startServer(name);
  if (res.ok && res.url) shell.openExternal(res.url);
  return res;
});

ipcMain.handle("open-external", async (_e, url) => {
  if (!/^https?:\/\//i.test(url || "")) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("open-site-folder", async (_e, name) => {
  const site = getSites().find((s) => s.name === name);
  if (!site) return { ok: false, error: "Unknown site." };
  if (!fs.existsSync(site.root)) {
    return { ok: false, error: "Folder is gone, re-download it." };
  }
  const err = await shell.openPath(path.resolve(site.root));
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle("stop-site", async (_e, name) => {
  if (servers.has(name)) {
    await servers.get(name).close().catch(() => {});
    servers.delete(name);
  }
  return { ok: true };
});

ipcMain.handle("delete-site", async (_e, name) => {
  const site = getSites().find((s) => s.name === name);
  if (!site) return { ok: false, error: "Unknown site." };

  if (servers.has(name)) {
    await servers.get(name).close().catch(() => {});
    servers.delete(name);
  }
  try {
    await removeDir(site.root);
  } catch (e) {
    return { ok: false, error: `Could not delete files: ${e.message}` };
  }
  saveSites(getSites().filter((s) => s.name !== name));
  return { ok: true, deleted: true };
});

app.on("before-quit", () => {
  for (const s of servers.values()) s.close().catch(() => {});
});
