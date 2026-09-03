const CACHE_NAME="yutori-v0.3.32";
const APP_SHELL=[
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/yutori-logo.svg",
  "./assets/yutori-app-icon.svg",
  "./assets/yutori-symbol.svg",
  "./assets/yutori-192.png",
  "./assets/yutori-512.png",
  "./assets/settings.svg",
  "./assets/test-mark-name-header.svg",
  "./assets/grade-circle-hand.svg",
  "./assets/grade-cross-hand.svg",
  "./assets/grade-triangle-hand.svg",
  "./assets/pdfjs/pdf.min.js",
  "./assets/pdfjs/pdf.worker.min.js"
];

self.addEventListener("install",event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(APP_SHELL))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key.startsWith("yutori-v")&&key!==CACHE_NAME).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==="navigate"){
    event.respondWith(
      fetch(request)
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put("./index.html",copy));
          return response;
        })
        .catch(()=>caches.match("./index.html"))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(cached=>cached||fetch(request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));
      return response;
    }))
  );
});
