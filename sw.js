/* 離線支援：把網頁、圖片、json 存在玩家裝置上。
   策略：
   - 網頁(html)、程式(js)、題庫(json)：網路優先。有網路就一定拿到最新版，連不上才用裝置上存的舊版（離線也能玩）。
   - 圖片等其他檔案：有存過就先用（秒開），同時背景抓新版更新下次用；沒存過就連網，成功後存起來。
   mp3 音檔不在這裡處理（由遊戲頁面自己下載與管理）。
   網路優先之後，更新遊戲不必再改版本號；只有想強制清掉所有舊快取時，才把下面的 v2 改成 v3。 */
const CACHE = 'td-shell-v2';
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
  const networkFirst = req.mode === 'navigate' || /\.(html?|js|json)$/i.test(url.pathname) || url.pathname.endsWith('/');
  e.respondWith((async()=>{
    const cache = await caches.open(CACHE);
    if(networkFirst){
      try{
        const r = await fetch(req, { cache:'no-cache' }); // 避開瀏覽器自己的 HTTP 快取，確保拿到最新版
        if(r && r.ok) cache.put(req, r.clone());
        return r;
      }catch(err){
        const hit = await cache.match(req);
        if(hit) return hit;
        if(req.mode === 'navigate'){ const fb = await cache.match('./') || await cache.match('./Tower_Defense.html'); if(fb) return fb; }
        return Response.error();
      }
    }
    const hit = await cache.match(req);
    const net = fetch(req).then(r=>{ if(r && r.ok) cache.put(req, r.clone()); return r; }).catch(()=>null);
    if(hit){ e.waitUntil(net); return hit; }
    const r = await net;
    if(r) return r;
    return Response.error();
  })());
});
