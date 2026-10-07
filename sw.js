/* 離線支援：把網頁、圖片、json 存在玩家裝置上。
   策略：有存過就先用（秒開），同時背景抓新版更新下次用；沒存過就連網，成功後存起來。
   mp3 音檔不在這裡處理（由遊戲頁面自己下載與管理）。
   更新遊戲後如果想讓所有人立刻換新版，把下面的 v1 改成 v2。 */
const CACHE = 'td-shell-v1';
self.addEventListener('install', ()=>{ self.skipWaiting(); });
self.addEventListener('activate', e=>{
  e.waitUntil((async()=>{
    for(const k of await caches.keys()) if(k.startsWith('td-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e=>{
  const req = e.request, url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== location.origin) return;
  if(/\.mp3$/i.test(url.pathname) || req.headers.has('range')) return;
  e.respondWith((async()=>{
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then(r=>{ if(r && r.ok) cache.put(req, r.clone()); return r; }).catch(()=>null);
    if(hit){ e.waitUntil(net); return hit; }
    const r = await net;
    if(r) return r;
    if(req.mode === 'navigate'){ const fb = await cache.match('./') || await cache.match('./Tower_Defense.html'); if(fb) return fb; }
    return Response.error();
  })());
});
