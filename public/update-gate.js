// Prism open-time version check (Neil, Nov 23, 2026).
//
// Every launch, before the opening film plays and before the Shelf
// appears, this gate asks the service worker whether a newer build
// exists. If one does, it is downloaded and activated behind a brief
// veil, and the page reloads once into the fresh build — the reader
// never settles into a stale copy. If there is no new build, the app
// boots at once with no veil and no delay worth naming. If the check
// itself fails (offline, worker unsupported), the cached build opens
// normally and nothing is said.
//
// Loop safety: at most one update reload per browser session
// (sessionStorage), and never a reload for the very first install.
(function () {
  var RELOADED_KEY = "prism-update-reloaded";
  var BOOT_GRACE_MS = 1500; // no update found by now -> boot as-is
  var UPDATE_DEADLINE_MS = 12000; // update found but never lands -> boot as-is
  var AWAY_MS = 5 * 60 * 1000; // foreground return after this long re-checks

  var booted = false;
  var updatePending = false;
  var refreshing = false;
  var hadController = !!(
    "serviceWorker" in navigator && navigator.serviceWorker.controller
  );
  var registration = null;
  var veilEl = null;
  var veilTimer = null;

  function boot() {
    if (booted) return;
    booted = true;
    var s = document.createElement("script");
    s.src = "/main.js";
    document.body.appendChild(s);
  }

  function showVeil() {
    if (veilEl) return;
    veilEl = document.createElement("div");
    veilEl.setAttribute("role", "status");
    veilEl.textContent = "A moment — bringing in the newest Prism…";
    veilEl.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
      "justify-content:center;text-align:center;padding:24px;" +
      "background:#01313E;color:#FFF3DC;" +
      "font-family:Nunito,system-ui,sans-serif;font-weight:700;font-size:18px;" +
      "letter-spacing:.02em;opacity:0;transition:opacity .6s ease;";
    document.body.appendChild(veilEl);
    // Fade in on the next frame so the transition runs.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (veilEl) veilEl.style.opacity = "1";
      });
    });
  }

  function veilSoon() {
    if (veilTimer) return;
    veilTimer = setTimeout(showVeil, 250);
  }

  function markUpdatePending(worker) {
    if (!hadController) return; // first install is not an update
    updatePending = true;
    veilSoon();
    if (worker && worker.state === "installed" && registration && registration.waiting === worker) {
      // Already waiting on activation: nudge it (the worker also
      // skipWaits on its own; this is belt and braces).
      try {
        worker.postMessage({ type: "SKIP_WAITING" });
      } catch (e) {}
    }
  }

  function watchInstalling(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      if (worker.state === "installed") markUpdatePending(worker);
    });
    if (worker.state === "installed") markUpdatePending(worker);
  }

  if (!("serviceWorker" in navigator)) {
    boot();
    return;
  }

  // An activating update takes control: reload once, behind the veil,
  // into the fresh build. Guarded so it can never loop.
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (refreshing || !updatePending || !hadController) return;
    try {
      if (sessionStorage.getItem(RELOADED_KEY)) return;
      sessionStorage.setItem(RELOADED_KEY, "1");
    } catch (e) {
      return; // no storage: never risk a reload loop
    }
    refreshing = true;
    showVeil();
    setTimeout(function () {
      location.reload();
    }, 400);
  });

  navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .then(function (reg) {
      registration = reg;
      if (reg.waiting && hadController) markUpdatePending(reg.waiting);
      if (reg.installing) watchInstalling(reg.installing);
      reg.addEventListener("updatefound", function () {
        watchInstalling(reg.installing);
      });
      // The common case settles here: the check comes back with no
      // new build, and the app boots at once — no fixed wait.
      reg
        .update()
        .then(function () {
          if (!hadController || (!updatePending && !reg.installing)) boot();
        })
        .catch(function () {});

      // Backstops: boot by the grace mark if nothing is on its way;
      // if an update is, wait for the reload — but never hold the
      // reader hostage.
      setTimeout(function () {
        if (!updatePending) boot();
      }, BOOT_GRACE_MS);
      setTimeout(boot, UPDATE_DEADLINE_MS);
    })
    .catch(function () {
      boot();
    });

  // Return to the foreground after a spell away: check again. The
  // updatefound/controllerchange path above handles any landing.
  var hiddenAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
    } else if (
      hiddenAt &&
      Date.now() - hiddenAt > AWAY_MS &&
      registration
    ) {
      hiddenAt = 0;
      registration.update().catch(function () {});
    }
  });
})();
