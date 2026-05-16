const { BrowserWindow, session } = require("electron");

// Renders a page in a hidden window so client-side JS runs and lazy /
// scroll-triggered content loads. Also records every http(s) resource the
// page actually requests (incl. runtime-imported JS chunks Framer & co.
// pull in) so the crawler can mirror them too.
// Returns { html, finalUrl, requests }.

let seq = 0;

function once(emitter, event, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    emitter.once(event, () => finish(true));
    setTimeout(() => finish(false), ms);
  });
}

async function renderPage(url, { timeoutMs = 25000 } = {}) {
  const partition = `render-${Date.now()}-${seq++}`;
  const sess = session.fromPartition(partition);

  const requests = new Set();
  const onCompleted = (details) => {
    if (/^https?:\/\//i.test(details.url)) requests.add(details.url);
  };
  sess.webRequest.onCompleted(onCompleted);

  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 1000,
    webPreferences: { partition, sandbox: true },
  });

  // Hard ceiling: never let a single page hang the whole crawl.
  const killer = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, timeoutMs + 20000);

  try {
    win.loadURL(url).catch(() => {});
    // Resolve when the page stops loading, or fall through on timeout —
    // a stalled sub-resource shouldn't block us.
    await once(win.webContents, "did-stop-loading", timeoutMs);
    if (win.isDestroyed()) throw new Error("window closed");

    const run = (js) => win.webContents.executeJavaScript(js, true);

    await run("new Promise(r => setTimeout(r, 700))"); // SPA paint

    // Step-scroll so IntersectionObserver / lazy media / chunk imports fire.
    await run(`
      (async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let last = -1;
        for (let i = 0; i < 30; i++) {
          window.scrollTo(0, document.body.scrollHeight);
          await sleep(220);
          const h = document.body.scrollHeight;
          if (h === last) break;
          last = h;
        }
        window.scrollTo(0, 0);
        await sleep(350);
      })();
    `);
    await run("new Promise(r => setTimeout(r, 500))"); // settle requests

    const html = await run("document.documentElement.outerHTML");
    const finalUrl = win.webContents.getURL() || url;
    return { html, finalUrl, requests: [...requests] };
  } finally {
    clearTimeout(killer);
    sess.webRequest.onCompleted(null);
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { renderPage };
