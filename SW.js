'use strict';
const PREFIX = `branch-sales:${self.registration.scope}:`;
const CACHE = `${PREFIX}shell-v3`;
const ROOT = new URL('./', self.registration.scope).href;
const INDEX = new URL('index.html', ROOT).href;
const SHELL = ['index.html','style.css','script.js','manifest.json','assets/icon-192.png',
 'assets/icon-512.png','assets/icon-180.png','assets/icon-maskable-512.png'].map(path => new URL(path,ROOT).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys
 .filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('message', event => { if(event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting(); });
self.addEventListener('fetch', event => {
 const request=event.request, url=new URL(request.url);
 if(request.method !== 'GET' || url.origin !== self.location.origin) return;
 const entry=request.mode === 'navigate' && (url.pathname === new URL(ROOT).pathname || url.pathname === new URL(INDEX).pathname);
 if(!entry && !SHELL.includes(url.href)) return;
 event.respondWith((async()=>{
  const cached=await (await caches.open(CACHE)).match(entry ? INDEX : request);
  if(cached) return cached;
  try { return await fetch(request); }
  catch { return new Response('Offline: เปิดออนไลน์เพื่อเตรียมไฟล์แอปก่อน',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}}); }
 })());
});
