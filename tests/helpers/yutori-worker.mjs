// Dedicated test helper: ordinary application browser contexts still block Service Workers.
export async function registerAndWaitForWorker(page, { timeoutMs = 5000, update = false } = {}) {
  return page.evaluate(({ timeoutMs, update }) => new Promise((resolve, reject) => {
    let registration, previous, target, settled = false;
    const watched = new Set(), removers = [];
    const describe = () => `installing=${registration?.installing?.state || "none"}, waiting=${registration?.waiting?.state || "none"}, active=${registration?.active?.state || "none"}, target=${target?.state || "none"}, controller=${navigator.serviceWorker.controller?.state || "none"}`;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const remove of removers) remove();
      if (error) reject(error); else resolve(value);
    };
    const listen = (object, event, callback) => {
      if (settled) return;
      object.addEventListener(event, callback);
      removers.push(() => object.removeEventListener(event, callback));
    };
    const failed = () => finish(new Error(`Service Worker install failed (${describe()})`));
    const check = () => {
      if (settled || !registration) return;
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (!worker || (update && worker === previous) || watched.has(worker)) continue;
        watched.add(worker); target = worker;
        listen(worker, "statechange", check); listen(worker, "error", failed);
      }
      if (target?.state === "redundant") return finish(new Error(`Service Worker became redundant before activation/control (${describe()})`));
      if (target?.state === "activated" && registration.active === target && navigator.serviceWorker.controller === target) {
        finish(null, { state: target.state, controlled: true });
      }
    };
    // Starts before register/update, so even missing registration or controller activation is bounded.
    const timer = setTimeout(() => finish(new Error(`Service Worker activation/control deadline after ${timeoutMs}ms (${describe()})`)), timeoutMs);
    listen(navigator.serviceWorker, "controllerchange", check);
    (async () => {
      registration = await navigator.serviceWorker.getRegistration();
      previous = registration?.active;
      if (settled) return;
      if (!registration) registration = await navigator.serviceWorker.register("/sw.js");
      if (settled) return;
      listen(registration, "updatefound", check); listen(registration, "installerror", failed);
      check();
      if (update && !settled && !registration.installing && !registration.waiting) {
        await registration.update(); check();
      }
    })().catch(error => finish(new Error(`Service Worker registration/update failed: ${error.name} (${describe()})`)));
  }), { timeoutMs, update });
}
