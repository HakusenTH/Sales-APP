(function (root) {
  'use strict';
  const VERSION = 2;
  const PHOTO_KEYS = ['demo', 'spec', 'clean'];
  const CATALOG = Object.freeze([
    { id: '1', brand: 'Apple', model: 'iPhone 15 Pro', aliases: ['ip15p','15p','ip'], comm: 600 },
    { id: '2', brand: 'Samsung', model: 'Galaxy S24 Ultra', aliases: ['s24','s24u','ss'], comm: 1000 },
    { id: '3', brand: 'Oppo', model: 'Reno 11 5G', aliases: ['rn11','reno','oppo'], comm: 400 }
  ]);
  class AppError extends Error {
    constructor(code, message) { super(message); this.name = 'AppError'; this.code = code; }
  }
  const fail = (code, message) => { throw new AppError(code, message); };
  function id() {
    if (!root.crypto?.randomUUID) fail('unsupported', 'กรุณาเปิดผ่าน HTTPS บนเบราว์เซอร์รุ่นปัจจุบัน');
    return root.crypto.randomUUID();
  }
  function businessDate(value = new Date()) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) fail('invalid-date', 'วันที่ไม่ถูกต้อง');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok', calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).map(x => [x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function isValidImei(value) {
    if (typeof value !== 'string' || !/^\d{15}$/.test(value) || /^(\d)\1{14}$/.test(value)) return false;
    const sum = [...value].reduce((total, digit, i) => {
      let n = Number(digit); if (i % 2) n *= 2;
      return total + (n > 9 ? n - 9 : n);
    }, 0);
    return sum % 10 === 0;
  }
  function summary(sales, now = new Date()) {
    const day = businessDate(now), month = day.slice(0,7);
    return sales.reduce((r,s) => {
      if (s.status === 'rejected') { r.rejected++; return r; }
      if (s.businessDate === day) r.today++;
      if (s.status === 'pending') r.pending++;
      if (s.businessDate.slice(0,7) === month) {
        if (s.status === 'confirmed') r.confirmed += s.commissionAmount;
        else r.estimated += s.commissionEstimate;
      }
      return r;
    }, { today:0, pending:0, rejected:0, confirmed:0, estimated:0 });
  }
  const scopeKey = (uid,branch,date) => JSON.stringify([uid,branch,date]);
  const requestValue = request => new Promise((resolve,reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  // Repository: all business writes resolve only after the IndexedDB commit.
  class IndexedDbRepository {
    constructor(db) { this.db = db; }
    static open(name = 'branch-sales-v2') {
      if (!root.indexedDB) return Promise.reject(new AppError('storage', 'เบราว์เซอร์ไม่รองรับการเก็บข้อมูลออฟไลน์'));
      return new Promise((resolve,reject) => {
        const req = root.indexedDB.open(name, VERSION);
        let settled = false;
        req.onupgradeneeded = () => {
          const db = req.result;
          const stores = [['sessions','id'],['sales','id'],['registry','key'],['drafts','key'],['outbox','operationId'],['meta','key']];
          for (const [name,keyPath] of stores) {
            if (db.objectStoreNames.contains(name)) continue;
            const store = db.createObjectStore(name,{keyPath});
            if (['sessions','sales','outbox'].includes(name)) store.createIndex('ownerUid','ownerUid');
            if (name === 'sessions') store.createIndex('activeKey','activeKey',{unique:true});
          }
        };
        req.onblocked = () => { settled=true; reject(new AppError('storage-blocked', 'กรุณาปิดแท็บรุ่นเก่าของแอปแล้วลองใหม่')); };
        req.onerror = () => { settled=true; reject(new AppError('storage', 'เปิดที่เก็บข้อมูลไม่ได้ กรุณาตรวจพื้นที่หรือโหมดส่วนตัว')); };
        req.onsuccess = () => {
          if (settled) { req.result.close(); return; }
          req.result.onversionchange = () => req.result.close();
          resolve(new IndexedDbRepository(req.result));
        };
      });
    }
    transaction(names,mode,work) {
      return new Promise((resolve,reject) => {
        let tx, result, failure;
        try { tx = this.db.transaction(names,mode); } catch (e) { reject(e); return; }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new AppError('storage','บันทึกข้อมูลไม่สำเร็จ'));
        // Requests are awaited within this task's microtasks, never a network request.
        Promise.resolve().then(() => work(tx)).then(value => { result=value; }).catch(error => {
          failure=error; try { tx.abort(); } catch (_) { reject(error); }
        });
      });
    }
    async enqueue(tx,operation) {
      const meta = tx.objectStore('meta');
      const counter = await requestValue(meta.get('queueSequence'));
      const sequence = (counter?.value || 0) + 1;
      await requestValue(meta.put({key:'queueSequence',value:sequence}));
      await requestValue(tx.objectStore('outbox').add({...operation,sequence,attempts:0,nextAttemptAt:0}));
    }
    getActive(uid,branch,day) {
      return this.transaction(['sessions'],'readonly',tx => requestValue(
        tx.objectStore('sessions').index('activeKey').get(scopeKey(uid,branch,day))));
    }
    getDraft(key) { return this.transaction(['drafts'],'readonly',tx => requestValue(tx.objectStore('drafts').get(key))); }
    saveDraft(key,ownerUid,photos) {
      return this.transaction(['drafts'],'readwrite',tx => requestValue(tx.objectStore('drafts').put({key,ownerUid,photos})));
    }
    createSession(session,remote) {
      return this.transaction(['sessions','drafts','outbox','meta'],'readwrite',async tx => {
        const sessions = tx.objectStore('sessions');
        if (await requestValue(sessions.index('activeKey').get(session.activeKey))) fail('already-open','เข้างานแล้ว กรุณาออกงานก่อน');
        await requestValue(sessions.add(session));
        await requestValue(tx.objectStore('drafts').delete(session.activeKey));
        if (remote) await this.enqueue(tx,{operationId:session.id,ownerUid:session.ownerUid,branchId:session.branchId,kind:'check-in',entityId:session.id,
          payload:{sessionId:session.id,ownerUid:session.ownerUid,branchId:session.branchId,businessDate:session.businessDate,openedAt:session.openedAt,
            evidence:session.evidence,checklist:session.checklist,stockStatus:session.stockStatus,workStatus:session.workStatus}});
        return session;
      });
    }
    closeSession({sessionId,ownerUid,branchId,evidence,operationId},remote) {
      return this.transaction(['sessions','outbox','meta'],'readwrite',async tx => {
        const store = tx.objectStore('sessions');
        const session = await requestValue(store.get(sessionId));
        if (!session || session.ownerUid !== ownerUid || session.branchId !== branchId || session.status !== 'open') fail('not-open','ยังไม่มีการเข้างานที่เปิดอยู่');
        session.status='closed'; session.closedAt=evidence.capturedAt;
        session.checkoutEvidence=evidence; session.checkoutOperationId=operationId;
        session.checkOutSyncStatus=remote ? 'pending' : 'local'; delete session.activeKey;
        await requestValue(store.put(session));
        if (remote) await this.enqueue(tx,{operationId,ownerUid,branchId,kind:'check-out',entityId:session.id,
          payload:{sessionId:session.id,ownerUid,branchId,closedAt:evidence.capturedAt,evidence}});
        return session;
      });
    }
    createSale(record,remote) {
      return this.transaction(['sessions','sales','registry','outbox','meta'],'readwrite',async tx => {
        const sales = tx.objectStore('sales');
        const prior = await requestValue(sales.get(record.id));
        if (prior) {
          if (prior.ownerUid !== record.ownerUid || prior.branchId !== record.branchId || prior.imei !== record.imei || prior.productId !== record.productId)
            fail('operation-conflict','รายการเดิมมีข้อมูลไม่ตรงกัน กรุณาตรวจสอบ');
          return prior;
        }
        const session = await requestValue(tx.objectStore('sessions').get(record.attendanceSessionId));
        if (!session || session.ownerUid !== record.ownerUid || session.branchId !== record.branchId ||
          session.status !== 'open' || session.businessDate !== record.businessDate || session.checkInSyncStatus === 'rejected')
          fail('attendance','กรุณาเข้างานสำหรับวันนี้ก่อนบันทึกยอดขาย');
        const registry = tx.objectStore('registry');
        const key = scopeKey(record.branchId,record.imei,'active');
        if (await requestValue(registry.get(key))) fail('duplicate-imei','IMEI นี้มีรายการขายบนเครื่องนี้แล้ว');
        await requestValue(sales.add(record));
        await requestValue(registry.add({key,saleId:record.id}));
        if (remote) await this.enqueue(tx,{operationId:record.id,ownerUid:record.ownerUid,branchId:record.branchId,kind:'sale',entityId:record.id,payload:record});
        return record;
      });
    }
    list(store,uid) { return this.transaction([store],'readonly',tx => requestValue(tx.objectStore(store).index('ownerUid').getAll(uid))); }
    read(store,key) { return this.transaction([store],'readonly',tx => requestValue(tx.objectStore(store).get(key))); }
    async complete(operation,receipt,rejection) {
      return this.transaction(['sales','sessions','outbox','registry'],'readwrite',async tx => {
        const name=operation.kind === 'sale' ? 'sales' : 'sessions';
        const store=tx.objectStore(name), record=await requestValue(store.get(operation.entityId));
        if (!record || record.ownerUid !== operation.ownerUid) fail('operation-conflict','ไม่พบรายการที่ตรงกับคิว');
        if (operation.kind === 'sale') {
          record.status=rejection ? 'rejected' : 'confirmed';
          if (!rejection) { record.commissionAmount=receipt.commissionAmount; record.serverSaleId=receipt.saleId; }
          if (rejection) await requestValue(tx.objectStore('registry').delete(scopeKey(record.branchId,record.imei,'active')));
        } else {
          record[operation.kind === 'check-in' ? 'checkInSyncStatus' : 'checkOutSyncStatus']=rejection ? 'rejected' : 'confirmed';
          record[operation.kind === 'check-in' ? 'checkInReceipt' : 'checkOutReceipt']=receipt || null;
          if (rejection && operation.kind === 'check-in') {record.status='rejected';delete record.activeKey;}
        }
        record.lastError=rejection || null; record.serverReceipt=receipt || null;
        await requestValue(store.put(record));
        await requestValue(tx.objectStore('outbox').delete(operation.operationId));
      });
    }
    defer(operation,error) {
      return this.transaction(['outbox'],'readwrite',async tx => {
        const store=tx.objectStore('outbox');
        const current=await requestValue(store.get(operation.operationId));
        if (!current) return;
        current.attempts++;
        current.lastError=String(error.message || 'ส่งข้อมูลไม่ได้');
        current.nextAttemptAt=Date.now()+Math.min(60000,1000*2**Math.min(current.attempts,6))+Math.random()*1000;
        await requestValue(store.put(current));
      });
    }
  }

  // Business services: adapters may be replaced without changing the views.
  function createServices({repo,config={},now=()=>new Date(),newId=id}) {
    const remote=config.mode === 'remote';
    const branchId=config.branchId || 'demo-branch';
    const maxAge=config.checklistMaxAgeMs ?? 15*60*1000;
    function requireUser(user) { if (!user?.uid) fail('auth','กรุณาเข้าสู่โปรไฟล์ก่อน'); }
    function validateEvidence(e) {
      const gps=e?.position, timestamp=Date.parse(e?.capturedAt);
      if (!(e?.blob instanceof root.Blob) || !e.blob.size || !e.blob.type.startsWith('image/')) fail('photo','ภาพยังไม่พร้อม');
      if (!gps || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lng) || Math.abs(gps.lat)>90 || Math.abs(gps.lng)>180 ||
        !Number.isFinite(gps.accuracy) || gps.accuracy<0 || !Number.isFinite(Date.parse(gps.capturedAt))) fail('gps','พิกัดไม่ถูกต้อง กรุณาลองใหม่');
      if (!Number.isFinite(timestamp) || now().getTime()-timestamp > maxAge || timestamp > now().getTime()+60000)
        fail('stale-photo','รูปตรวจสาขาหมดอายุ กรุณาถ่ายใหม่');
      if (businessDate(timestamp) !== businessDate(now())) fail('stale-photo','กรุณาถ่ายรูปสำหรับวันนี้');
    }
    return {
      remote,branchId,
      async login(email,password) {
        const normalized=email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail('email','กรุณากรอกอีเมลให้ถูกต้อง');
        if (!remote) return {uid:`demo:${normalized}`,email:normalized};
        if (!config.auth?.login || !config.auth?.logout || !config.api?.submitSale || !config.api?.submitAttendance || !config.api?.searchProducts || !config.branchId)
          fail('configuration','ยังไม่ได้ตั้งค่า Auth และ API สำหรับฐานข้อมูลจริง');
        const user=await config.auth.login({email:normalized,password});
        requireUser(user); return user;
      },
      async logout() { if (remote) await config.auth.logout(); },
      async active(user) { requireUser(user); return repo.getActive(user.uid,branchId,businessDate(now())); },
      async searchProducts(input) {
        const query=input.trim().toLowerCase(); if (!query) return [];
        const products=remote ? await config.api.searchProducts(query) : CATALOG;
        return products.filter(p=>p && p.id != null && typeof p.brand==='string' && typeof p.model==='string' && Number.isFinite(p.comm) && p.comm>=0)
          .filter(p=>`${p.brand} ${p.model}`.toLowerCase().includes(query) || (p.aliases||[]).some(a=>String(a).toLowerCase().includes(query))).slice(0,20);
      },
      async checkIn(user,photos,stockStatus,evidence,operationId) {
        requireUser(user);
        for (const key of PHOTO_KEYS) validateEvidence(photos[key]);
        validateEvidence(evidence);
        if (!['เพียงพอ','ต้องเติม'].includes(stockStatus)) fail('stock','กรุณาเลือกสถานะสต๊อก');
        const date=businessDate(now());
        return repo.createSession({id:operationId || newId(),ownerUid:user.uid,branchId,businessDate:date,
          activeKey:scopeKey(user.uid,branchId,date),status:'open',openedAt:evidence.capturedAt,
          evidence,checklist:photos,stockStatus,workStatus:'work',checkInSyncStatus:remote ? 'pending' : 'local'},remote);
      },
      async checkOut(user,evidence,operationId) {
        requireUser(user); validateEvidence(evidence);
        const session=await this.active(user);
        if (!session) fail('not-open','ยังไม่ได้เข้างานสำหรับวันนี้');
        return repo.closeSession({sessionId:session.id,ownerUid:user.uid,branchId,evidence,operationId:operationId || newId()},remote);
      },
      async saveSale(user,{product,imei,operationId}) {
        requireUser(user);
        if (!isValidImei(imei)) fail('imei','IMEI ต้องเป็นเลข 15 หลักและ checksum ถูกต้อง');
        if (!product?.id || !Number.isFinite(product.comm) || product.comm<0) fail('product','กรุณาเลือกสินค้า');
        const session=await this.active(user);
        if (!session) fail('attendance','กรุณาเข้างานสำหรับวันนี้ก่อน');
        const date=now().toISOString();
        return repo.createSale({id:operationId || newId(),ownerUid:user.uid,branchId,attendanceSessionId:session.id,
          productId:String(product.id),brand:product.brand,model:product.model,imei,date,businessDate:businessDate(date),
          commissionEstimate:product.comm,commissionAmount:null,status:remote ? 'pending' : 'local'},remote);
      },
      async sales(user) { requireUser(user); return (await repo.list('sales',user.uid)).filter(s=>s.branchId === branchId); }
    };
  }

  function getGPS({signal,timeoutMs=15000}={}) {
    return new Promise((resolve,reject)=>{
      let finished=false;
      const settle=(error,value)=>{ if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value); };
      const abort=()=>settle(new DOMException('ยกเลิก','AbortError'));
      const timer=setTimeout(()=>settle(new AppError('gps-timeout','รอ GPS นานเกินไป กรุณาลองใหม่')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)return abort();
      if(!root.isSecureContext || !root.navigator?.geolocation)return settle(new AppError('gps','ไม่รองรับ GPS หรือไม่ได้เปิดผ่าน HTTPS'));
      try { root.navigator.geolocation.getCurrentPosition(p=>settle(null,{lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy,capturedAt:new Date(p.timestamp).toISOString()}),
        e=>settle(new AppError('gps',({1:'กรุณาอนุญาตตำแหน่งในการตั้งค่าเบราว์เซอร์',2:'หาพิกัดไม่ได้ กรุณาลองใหม่',3:'รอ GPS นานเกินไป'})[e.code] || 'GPS ผิดพลาด')),
        {enableHighAccuracy:true,maximumAge:0,timeout:10000}); } catch(e) { settle(e); }
    });
  }
  function requestCamera({signal,timeoutMs=15000}={}) {
    return new Promise((resolve,reject)=>{
      let finished=false;
      const stop=stream=>stream.getTracks().forEach(t=>t.stop());
      const settle=(error,stream)=>{if(finished){if(stream)stop(stream);return;}finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(stream);};
      const abort=()=>settle(new DOMException('ยกเลิก','AbortError'));
      const timer=setTimeout(()=>settle(new AppError('camera-timeout','กรุณาตอบสิทธิ์กล้องแล้วลองใหม่')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
      if(!root.isSecureContext || !root.navigator?.mediaDevices?.getUserMedia)return settle(new AppError('camera','ไม่รองรับกล้องหรือไม่ได้เปิดผ่าน HTTPS'));
      try { root.navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}})
        .then(stream=>settle(null,stream),error=>settle(error)); } catch(e) {settle(e);}
    });
  }
  async function syncQueue({repo,api,user,branchId,stillCurrent=()=>true,force=false}) {
    const queue=(await repo.list('outbox',user.uid)).filter(o=>o.branchId === branchId).sort((a,b)=>a.sequence-b.sequence);
    let sent=0;
    for(const operation of queue) {
      if(!stillCurrent())break;
      if(!force && operation.nextAttemptAt>Date.now())break;
      const record=await repo.read(operation.kind==='sale'?'sales':'sessions',operation.entityId);
      if(operation.kind !== 'check-in') {
        const session=operation.kind==='sale' ? await repo.read('sessions',record.attendanceSessionId) : record;
        if(session?.checkInSyncStatus === 'rejected') {await repo.complete(operation,null,'การเข้างานถูกปฏิเสธ');continue;}
        if(session?.checkInSyncStatus !== 'confirmed')break;
      }
      try {
        const receipt=operation.kind==='sale'
          ? await api.submitSale({...operation.payload,operationId:operation.operationId})
          : await api.submitAttendance({kind:operation.kind,payload:operation.payload,operationId:operation.operationId});
        if(!receipt || receipt.accepted !== true || (operation.kind==='sale' &&
          (!receipt.saleId || !Number.isFinite(receipt.commissionAmount) || receipt.commissionAmount<0)))
          fail('invalid-receipt','Server ยังไม่ยืนยันรายการ');
        await repo.complete(operation,receipt,null);sent++;
      } catch(error) {
        const code=String(error.code||'').replace(/^functions\//,'');
        const permanent=error.permanent===true || ['invalid-argument','already-exists','permission-denied','failed-precondition','not-found'].includes(code);
        if(permanent) {await repo.complete(operation,null,String(error.message||'รายการถูกปฏิเสธ'));continue;}
        await repo.defer(operation,error);throw error;
      }
    }
    return sent;
  }
  const exported={AppError,businessDate,isValidImei,summary,scopeKey,IndexedDbRepository,createServices,getGPS,requestCamera,syncQueue,CATALOG};
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  root.BranchSalesCore=Object.freeze(exported);
  if(!root.document)return;
  bootstrap().catch(error=>{
    const element=document.getElementById('loginStatus');if(element)element.textContent=error.message;
    document.getElementById('loginButton').disabled=true;
  });

  async function bootstrap() {
    const config=root.BranchSalesConfig || {};
    const $=key=>document.getElementById(key);
    const state={user:null,session:null,photos:{},product:null,draftId:id(),epoch:0,route:'loginSection',camera:null,previewUrls:{},dirty:false,saving:false};
    let repo,services,loginBusy=false,searchToken=0,searchTimer,syncBusy=false,registration,openRequest=0;
    $('loginButton').disabled=true;
    const channel=typeof BroadcastChannel==='function' ? new BroadcastChannel('branch-sales-data') : null;
    const message=(target,text,error=false)=>{ $(target).textContent=text;$(target).classList.toggle('error',error); };
    const errorText=error=>({NotAllowedError:'กรุณาอนุญาตกล้องในการตั้งค่าเบราว์เซอร์',NotFoundError:'ไม่พบกล้องบนอุปกรณ์นี้',NotReadableError:'กล้องอาจถูกใช้งานโดยแอปอื่น'})[error.name] ||
      (error.name==='QuotaExceededError' ? 'พื้นที่เก็บข้อมูลเต็ม ยังไม่ได้บันทึก กรุณาสำรองข้อมูลและตรวจพื้นที่' : error.message || 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');
    function route(name) {
      if(name!=='loginSection' && !state.user)return;
      for(const key of ['loginSection','mainMenu','checkInSection','salesSection'])$(key).classList.toggle('hidden',key!==name);
      state.route=name;
      const heading=$(name).querySelector('h1');heading?.focus({preventScroll:true});
    }
    function revokePreviews() { for(const url of Object.values(state.previewUrls))URL.revokeObjectURL(url);state.previewUrls={}; }
    function renderPhotos() {
      revokePreviews();
      for(const key of PHOTO_KEYS) {
        const el=$(`preview-${key}`),photo=state.photos[key];el.classList.toggle('hidden',!photo);
        if(photo){const url=URL.createObjectURL(photo.blob);state.previewUrls[key]=url;el.src=url;}else el.removeAttribute('src');
      }
    }
    function draftKey(){return scopeKey(state.user.uid,services.branchId,businessDate());}
    function clearProduct() {
      state.product=null;searchToken++;$('searchInput').value='';$('searchInput').classList.remove('hidden');
      $('selectedProduct').classList.add('hidden');$('suggestions').replaceChildren();$('suggestions').classList.add('hidden');
      $('searchInput').setAttribute('aria-expanded','false');message('searchStatus','');
    }
    function resetUser() {
      state.epoch++;closeCamera();revokePreviews();state.user=null;state.session=null;state.photos={};state.dirty=false;state.draftId=id();
      clearProduct();$('imeiInput').value='';$('password').value='';$('salesTableBody').replaceChildren();$('todayCount').textContent='0';$('monthComm').textContent='0';
      for(const key of ['welcomeMsg','branchLabel','pendingSummary','menuStatus','actionStatus','saveStatus','dashboardStatus','syncStatus'])message(key,'');
      document.querySelectorAll('input[name="stockStatus"]').forEach(input=>{input.checked=false;});renderPhotos();route('loginSection');
    }
    async function refreshAttendance() {
      if(!state.user)return;const epoch=state.epoch;
      const session=await services.active(state.user);if(epoch!==state.epoch)return;
      state.session=session;
      $('currentStatus').textContent=session ? (session.checkInSyncStatus==='rejected' ? 'การเข้างานถูกปฏิเสธ' : 'เข้างานแล้ว') : 'ยังไม่เข้างาน / ออกงานแล้ว';
      $('attendanceSyncStatus').textContent=session ? statusLabel(session.checkInSyncStatus) : '';
      $('checkInButton').disabled=!!session;$('checkOutButton').disabled=!session || session.checkInSyncStatus==='rejected';
    }
    function statusLabel(status){return ({local:'เก็บในเครื่องทดลอง',pending:'รอส่ง',confirmed:'ยืนยันแล้ว',rejected:'ถูกปฏิเสธ'})[status] || status;}
    async function dashboard() {
      if(!state.user)return;const epoch=state.epoch;const sales=await services.sales(state.user);if(epoch!==state.epoch)return;
      const totals=summary(sales);$('todayCount').textContent=totals.today;$('monthComm').textContent=(services.remote ? totals.confirmed : totals.estimated).toLocaleString('th-TH');
      $('pendingSummary').textContent=services.remote ? `รอส่ง ${totals.pending} รายการ • ถูกปฏิเสธ ${totals.rejected} รายการ • ค่าคอมยังไม่ยืนยันเดือนนี้ ${totals.estimated.toLocaleString('th-TH')} บาท` : 'ยอดทดลองบนเครื่องนี้ ยังไม่ได้รับรองจากบริษัท';
      const fragment=document.createDocumentFragment();
      for(const sale of sales.filter(s=>s.businessDate===businessDate()).sort((a,b)=>b.date.localeCompare(a.date))) {
        const tr=document.createElement('tr');
        const values=[new Date(sale.date).toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'}),`${sale.brand} ${sale.model}`,`•••••••••••${sale.imei.slice(-4)}`,
          (sale.status==='confirmed' ? sale.commissionAmount : sale.commissionEstimate).toLocaleString('th-TH'),statusLabel(sale.status)];
        for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.appendChild(td);} if(sale.lastError)tr.lastChild.title=sale.lastError;
        fragment.appendChild(tr);
      }
      $('salesTableBody').replaceChildren(fragment);message('dashboardStatus',sales.some(s=>s.businessDate===businessDate()) ? '' : 'วันนี้ยังไม่มีรายการ');
    }
    function notifyChange(){channel?.postMessage({type:'changed'});}
    async function sync(force=false) {
      if(!services.remote || !state.user || syncBusy)return;
      syncBusy=true;const epoch=state.epoch,user=state.user;
      message('syncStatus','กำลังส่งรายการ...');
      try {
        const task=()=>syncQueue({repo,api:config.api,user,branchId:services.branchId,force,stillCurrent:()=>epoch===state.epoch});
        const count=root.navigator.locks ? await root.navigator.locks.request('branch-sales-sync',{ifAvailable:true},lock=>lock ? task() : 0) : await task();
        if(epoch===state.epoch){message('syncStatus',`ส่งยืนยันแล้ว ${count} รายการ`);await refreshAttendance();await dashboard();notifyChange();}
      } catch(error) {if(epoch===state.epoch)message('syncStatus',`ยังส่งไม่สำเร็จ: ${errorText(error)} รายการยังเก็บอยู่ในเครื่อง`,true);}
      finally {syncBusy=false;}
    }
    async function login(event) {
      event.preventDefault();if(loginBusy)return;loginBusy=true;$('loginButton').disabled=true;const epoch=++state.epoch;
      message('loginStatus','กำลังเปิดโปรไฟล์...');
      try {
        const user=await services.login($('email').value,$('password').value);if(epoch!==state.epoch)return;
        state.user=user;state.photos=(await repo.getDraft(draftKey()))?.photos || {};
        if(epoch!==state.epoch)return;
        $('welcomeMsg').textContent=`สวัสดี ${user.email || user.uid}`;$('branchLabel').textContent=config.branchName || 'สาขาทดลอง';
        renderPhotos();await refreshAttendance();route('mainMenu');message('loginStatus','');void sync();
      } catch(error){resetUser();message('loginStatus',errorText(error),true);}
      finally{loginBusy=false;$('loginButton').disabled=false;}
    }
    async function search() {
      const token=++searchToken,epoch=state.epoch,input=$('searchInput').value;
      if(!input.trim()){clearProduct();return;}
      try {
        const products=await services.searchProducts(input);if(token!==searchToken || epoch!==state.epoch)return;
        const fragment=document.createDocumentFragment();
        for(const product of products){const button=document.createElement('button');button.type='button';button.className='suggestion-item';
          button.textContent=`${product.brand} ${product.model} • ประมาณการ ${product.comm.toLocaleString('th-TH')} บาท`;
          button.addEventListener('click',()=>{state.product={...product};$('dispBrandModel').textContent=`${product.brand} ${product.model}`;$('dispComm').textContent=product.comm;
            $('searchInput').classList.add('hidden');$('selectedProduct').classList.remove('hidden');$('suggestions').classList.add('hidden');$('searchInput').setAttribute('aria-expanded','false');state.dirty=true;$('imeiInput').focus();});fragment.appendChild(button);}
        $('suggestions').replaceChildren(fragment);$('suggestions').classList.toggle('hidden',!products.length);$('searchInput').setAttribute('aria-expanded',String(!!products.length));message('searchStatus',products.length ? '' : 'ไม่พบสินค้า');
      } catch(error){if(token===searchToken)message('searchStatus',errorText(error),true);}
    }
    async function saveSale(event) {
      event.preventDefault();if(state.saving)return;state.saving=true;$('saveSaleButton').disabled=true;const epoch=state.epoch;
      let committed=false;
      try {
        await services.saveSale(state.user,{product:state.product,imei:$('imeiInput').value.trim(),operationId:state.draftId});
        committed=true;
        if(epoch!==state.epoch)return;
        state.draftId=id();state.dirty=false;clearProduct();$('imeiInput').value='';
        message('saveStatus',services.remote ? 'เก็บในเครื่องแล้ว • รอส่งและตรวจสอบจากบริษัท' : 'บันทึกในเครื่องทดลองแล้ว • ค่าคอมเป็นประมาณการ');
        await dashboard();notifyChange();void sync();
      }catch(error){if(epoch===state.epoch)message('saveStatus',committed ? 'บันทึกแล้ว แต่โหลดสรุปไม่สำเร็จ กรุณาเปิดหน้าขายใหม่' : errorText(error),true);}
      finally{state.saving=false;$('saveSaleButton').disabled=false;}
    }

    function closeCamera() {
      openRequest++;
      const camera=state.camera;if(!camera)return;
      state.camera=null;camera.controller.abort();camera.stream?.getTracks().forEach(t=>t.stop());
      if(camera.worker){const worker=camera.worker;camera.worker=null;void worker.terminate().catch(()=>{});}
      const video=$('videoElement');video.pause();video.srcObject=null;$('cameraModal').classList.add('hidden');document.body.classList.remove('camera-open');
      for(const element of camera.inertElements)element.inert=false;
      if(camera.previousFocus?.isConnected)camera.previousFocus.focus({preventScroll:true});
    }
    async function openCamera(mode) {
      if(!state.user || state.saving)return;
      const allowed=[...PHOTO_KEYS,'ocr','check-in','check-out'];if(!allowed.includes(mode))return;
      const target=mode==='ocr'?'saveStatus':'actionStatus';
      const epoch=state.epoch,opening=++openRequest;let camera;
      try {
        await refreshAttendance();
        if(epoch!==state.epoch || opening!==openRequest)return;
        if(mode==='ocr' && !state.session)fail('attendance','กรุณาเข้างานสำหรับวันนี้ก่อน');
        if(mode==='check-in') {
          if(state.session)fail('already-open','เข้างานแล้ว กรุณาออกงานก่อน');
          for(const key of PHOTO_KEYS)if(!state.photos[key])fail('checklist','กรุณาถ่ายรูปตรวจสาขาให้ครบ 3 ข้อ');
          if(!document.querySelector('input[name="stockStatus"]:checked'))fail('stock','กรุณาเลือกสถานะสต๊อก');
        }
        if(mode==='check-out' && !state.session)fail('not-open','ยังไม่ได้เข้างานสำหรับวันนี้');
        closeCamera();
        camera={mode,epoch:state.epoch,controller:new AbortController(),stream:null,worker:null,busy:false,position:null,operationId:id(),previousFocus:document.activeElement,
          inertElements:[...document.body.children].filter(el=>el.id!=='cameraModal' && el.tagName!=='SCRIPT')};
        state.camera=camera;for(const el of camera.inertElements)el.inert=true;
        $('cameraTitle').textContent=mode==='ocr'?'สแกน IMEI':'ถ่ายรูปยืนยัน';$('scanBox').classList.toggle('hidden',mode!=='ocr');$('btnCapture').disabled=true;
        $('cameraModal').classList.remove('hidden');document.body.classList.add('camera-open');$('cancelCameraButton').focus();
        if(mode!=='ocr'){
          message('cameraSubtitle','กำลังหาพิกัด...');camera.position=await getGPS({signal:camera.controller.signal});
          if(state.camera!==camera)return;
          message('cameraSubtitle',`พิกัด ${camera.position.lat.toFixed(4)}, ${camera.position.lng.toFixed(4)} • ±${Math.round(camera.position.accuracy)} เมตร`);
        }else message('cameraSubtitle','กรอบเลข IMEI ในช่อง • OCR ต้องใช้อินเทอร์เน็ต');
        const stream=await requestCamera({signal:camera.controller.signal});
        if(state.camera!==camera){stream.getTracks().forEach(t=>t.stop());return;}
        camera.stream=stream;const video=$('videoElement');video.srcObject=stream;await video.play();
        if(state.camera!==camera)return;
        $('btnCapture').disabled=false;
      }catch(error){if(error.name==='AbortError' || epoch!==state.epoch || (camera && state.camera!==camera))return;closeCamera();message(target,errorText(error),true);}
    }
    let ocrLibrary;
    function loadOCR() {
      if(root.Tesseract)return Promise.resolve(root.Tesseract);
      if(!root.navigator.onLine)return Promise.reject(new AppError('ocr-offline','OCR ต้องใช้อินเทอร์เน็ต กรอก IMEI ด้วยมือได้'));
      if(ocrLibrary)return ocrLibrary;
      ocrLibrary=new Promise((resolve,reject)=>{
        const script=document.createElement('script');let done=false;
        const end=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(root.Tesseract);};
        const timer=setTimeout(()=>{script.remove();end(new AppError('ocr-timeout','โหลด OCR ไม่สำเร็จ กรุณากรอก IMEI ด้วยมือ'));},15000);
        script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';script.crossOrigin='anonymous';
        script.onload=()=>end(root.Tesseract ? null : new AppError('ocr','OCR ไม่พร้อม'));
        script.onerror=()=>end(new AppError('ocr','โหลด OCR ไม่ได้ กรุณากรอก IMEI ด้วยมือ'));document.head.appendChild(script);
      }).catch(error=>{ocrLibrary=null;throw error;});return ocrLibrary;
    }
    function canvasBlob(canvas) {return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new AppError('photo','สร้างภาพไม่สำเร็จ')),'image/jpeg',.72));}
    async function capture() {
      const camera=state.camera;if(!camera || camera.busy)return;
      const video=$('videoElement');if(video.readyState<2 || !video.videoWidth || !video.videoHeight){message('cameraSubtitle','กล้องยังไม่พร้อม กรุณารอสักครู่');return;}
      camera.busy=true;$('btnCapture').disabled=true;let worker,attendanceCommit=false,persisted=false;
      try {
        const canvas=$('canvasElement'),ctx=canvas.getContext('2d');if(!ctx)fail('photo','อุปกรณ์ไม่รองรับการสร้างภาพ');
        if(camera.mode==='ocr'){
          const vr=video.getBoundingClientRect(),sr=$('scanBox').getBoundingClientRect();
          // Account for object-fit: contain letterboxing before mapping CSS to pixels.
          const scale=Math.min(vr.width/video.videoWidth,vr.height/video.videoHeight);
          const left=vr.left+(vr.width-video.videoWidth*scale)/2,top=vr.top+(vr.height-video.videoHeight*scale)/2;
          const sx=Math.max(0,(sr.left-left)/scale),sy=Math.max(0,(sr.top-top)/scale);
          const sw=Math.min(video.videoWidth-sx,sr.width/scale),sh=Math.min(video.videoHeight-sy,sr.height/scale);
          if(sw<=0 || sh<=0)fail('ocr','กรอบสแกนอยู่นอกภาพ กรุณาปรับกล้อง');
          canvas.width=Math.round(sw);canvas.height=Math.round(sh);ctx.drawImage(video,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
          message('cameraSubtitle','กำลังเตรียม OCR...');const library=await loadOCR();if(state.camera!==camera)return;
          const timeout=setTimeout(()=>{if(state.camera===camera){closeCamera();message('saveStatus','OCR ใช้เวลานานเกินไป กรุณากรอก IMEI ด้วยมือ',true);}},30000);
          try {
            worker=await library.createWorker('eng',1);if(state.camera!==camera){await worker.terminate();worker=null;return;}camera.worker=worker;
            await worker.setParameters({tessedit_char_whitelist:'0123456789'});message('cameraSubtitle','กำลังอ่านเลข IMEI...');
            const result=await worker.recognize(canvas);if(state.camera!==camera)return;
            const candidates=[...new Set((result.data.text.match(/\b\d{15}\b/g)||[]).filter(isValidImei))];
            if(candidates.length!==1)fail('ocr',candidates.length ? 'พบหลาย IMEI กรุณากรอกเลขที่ต้องการด้วยมือ' : 'ยังอ่าน IMEI ไม่ได้ กรุณาลองใหม่หรือกรอกด้วยมือ');
            $('imeiInput').value=candidates[0];state.dirty=true;closeCamera();message('saveStatus','อ่านเลขแล้ว กรุณาตรวจ IMEI ก่อนบันทึก');
          }finally{clearTimeout(timeout);}
        }else{
          const scale=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
          ctx.drawImage(video,0,0,canvas.width,canvas.height);
          // Refresh position at capture, instead of silently reusing the modal's old GPS.
          const capturedAt=new Date().toISOString();
          const position=await getGPS({signal:camera.controller.signal});if(state.camera!==camera)return;
          const evidence={blob:await canvasBlob(canvas),position,capturedAt};if(state.camera!==camera)return;
          if(PHOTO_KEYS.includes(camera.mode)){
            const photos={...state.photos,[camera.mode]:evidence};await repo.saveDraft(draftKey(),state.user.uid,photos);
            if(state.camera!==camera)return;state.photos=photos;renderPhotos();closeCamera();message('actionStatus','เก็บภาพตรวจสาขาในเครื่องแล้ว');
          }else{
            state.saving=true;attendanceCommit=true;
            if(camera.mode==='check-in'){
              await services.checkIn(state.user,state.photos,document.querySelector('input[name="stockStatus"]:checked')?.value,evidence,camera.operationId);
              persisted=true;
              if(camera.epoch!==state.epoch)return;state.photos={};renderPhotos();document.querySelectorAll('input[name="stockStatus"]').forEach(input=>{input.checked=false;});
            }else {await services.checkOut(state.user,evidence,camera.operationId);persisted=true;}
            if(camera.epoch!==state.epoch)return;
            closeCamera();await refreshAttendance();route('mainMenu');message('menuStatus',services.remote ? 'เก็บหลักฐานแล้ว • รอส่งและยืนยัน' : 'บันทึกเวลา รูป และพิกัดในเครื่องทดลองแล้ว');notifyChange();void sync();
          }
        }
      }catch(error){if(persisted && camera.epoch===state.epoch){closeCamera();route('mainMenu');message('menuStatus','บันทึกหลักฐานแล้ว แต่โหลดสถานะไม่สำเร็จ กรุณาเปิดเมนูใหม่',true);}
        else if(state.camera===camera && error.name!=='AbortError')message('cameraSubtitle',errorText(error),true);}
      finally{
        if(attendanceCommit)state.saving=false;
        if(worker && camera.worker===worker){camera.worker=null;await worker.terminate().catch(()=>{});}
        if(state.camera===camera){camera.busy=false;$('btnCapture').disabled=false;}
      }
    }
    async function exportCurrent() {
      const user=state.user;if(!user)return;
      const sales=await services.sales(user);const sessions=(await repo.list('sessions',user.uid)).filter(s=>s.branchId===services.branchId);
      // Include durable photo evidence as base64 for a portable, user-requested backup.
      const convert=async value=>{
        if(value instanceof Blob)return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({type:value.type,dataUrl:reader.result});reader.onerror=()=>reject(reader.error);reader.readAsDataURL(value);});
        if(Array.isArray(value))return Promise.all(value.map(convert));
        if(value && typeof value==='object'){const result={};for(const [k,v]of Object.entries(value))result[k]=await convert(v);return result;}return value;
      };
      download('branch-sales-backup.json',await convert({schemaVersion:VERSION,exportedAt:new Date().toISOString(),user,branchId:services.branchId,sales,sessions,
        checklistDraft:await repo.getDraft(scopeKey(user.uid,services.branchId,businessDate())),outbox:(await repo.list('outbox',user.uid)).filter(o=>o.branchId===services.branchId)}));
    }
    function download(filename,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    async function action(event) {
      const button=event.target.closest('[data-action]');if(!button || button.disabled)return;
      const name=button.dataset.action;
      if(state.saving)return;
      try {
        if(name==='menu'){closeCamera();await refreshAttendance();route('mainMenu');}
        if(name==='check-in-page'){await refreshAttendance();route('checkInSection');}
        if(name==='sales-page'){await refreshAttendance();if(!state.session || state.session.checkInSyncStatus==='rejected')fail('attendance','กรุณาเข้างานสำหรับวันนี้ก่อน');route('salesSection');await dashboard();}
        if(name==='logout'){
          if(state.saving)return;
          if(state.dirty && !root.confirm('ฟอร์มขายยังไม่ได้บันทึก ออกจากโปรไฟล์หรือไม่?'))return;
          await services.logout();resetUser();
        }
        if(name==='camera')await openCamera(button.dataset.mode);
        if(name==='check-in')await openCamera('check-in');if(name==='check-out')await openCamera('check-out');
        if(name==='close-camera')closeCamera();if(name==='capture')await capture();if(name==='clear-product'){clearProduct();$('searchInput').focus();}
        if(name==='sync')await sync(true);if(name==='export-current')await exportCurrent();
        if(name==='export-legacy')download('legacy-unverified.json',{unverified:true,mockSales:localStorage.getItem('mockSales'),mockCheckInStatus:localStorage.getItem('mockCheckInStatus')});
        if(name==='update'){
          if(state.camera || state.saving || state.dirty){message('menuStatus','เก็บหรือยกเลิกฟอร์มที่เปิดอยู่ก่อนอัปเดต',true);return;}
          if(registration?.waiting){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});}
        }
      }catch(error){message(state.route==='salesSection'?'saveStatus':state.route==='checkInSection'?'actionStatus':state.route==='loginSection'?'loginStatus':'menuStatus',errorText(error),true);}
    }
    function connection(){message('connectionStatus',navigator.onLine?'ออนไลน์':'ออฟไลน์ • ข้อมูลยังเก็บในเครื่อง');}
    async function setupWorker() {
      if(!('serviceWorker' in navigator) || !root.isSecureContext){message('offlineStatus','ต้องใช้ HTTPS เพื่อเปิดโหมดออฟไลน์');return;}
      try {
        registration=await navigator.serviceWorker.register('./SW.js');
        const ready=()=>{if(navigator.serviceWorker.controller)message('offlineStatus','โหมดออฟไลน์พร้อม');else message('offlineStatus','เปิดแอปอีกครั้งเพื่อเริ่มโหมดออฟไลน์');};
        ready();navigator.serviceWorker.addEventListener('controllerchange',ready);
        const waiting=()=>{if(registration.waiting)$('updateNotice').classList.remove('hidden');};waiting();
        registration.addEventListener('updatefound',()=>{const installing=registration.installing;installing?.addEventListener('statechange',()=>{if(installing.state==='installed'){ready();waiting();}if(installing.state==='redundant')message('offlineStatus','เตรียมโหมดออฟไลน์ไม่สำเร็จ');});});
      }catch(_){message('offlineStatus','โหมดออฟไลน์ไม่พร้อม กรุณาลองเปิดใหม่');}
    }
    $('loginForm').addEventListener('submit',login);$('saleForm').addEventListener('submit',saveSale);document.addEventListener('click',action);
    $('searchInput').addEventListener('input',()=>{state.dirty=true;clearTimeout(searchTimer);searchToken++;searchTimer=setTimeout(()=>void search(),150);});
    $('imeiInput').addEventListener('input',()=>{state.dirty=true;message('saveStatus','');});
    $('searchInput').addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();$('suggestions').querySelector('button')?.focus();}});
    $('suggestions').addEventListener('keydown',event=>{const buttons=[...$('suggestions').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(event.key==='ArrowDown' || event.key==='ArrowUp'){event.preventDefault();buttons[(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(event.key==='Escape')$('searchInput').focus();});
    document.addEventListener('keydown',event=>{
      if(!state.camera)return;if(event.key==='Escape'){event.preventDefault();closeCamera();}
      if(event.key==='Tab'){const buttons=[...$('cameraModal').querySelectorAll('button:not(:disabled)')];const first=buttons[0],last=buttons.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}}
    });
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')closeCamera();else if(state.user){void refreshAttendance().catch(e=>message('menuStatus',errorText(e),true));void sync();}});
    root.addEventListener('pagehide',closeCamera);root.addEventListener('beforeunload',event=>{if(state.dirty || state.saving){event.preventDefault();event.returnValue='';}});
    root.addEventListener('online',()=>{connection();void sync();});root.addEventListener('offline',connection);
    channel?.addEventListener('message',()=>{if(state.user){void refreshAttendance().then(()=>dashboard()).catch(e=>message('menuStatus',errorText(e),true));}});
    connection();void setupWorker();
    repo=await IndexedDbRepository.open();services=createServices({repo,config});$('loginButton').disabled=false;
    $('syncButton').classList.toggle('hidden',!services.remote);
    if(services.remote){$('modeNotice').textContent='รายการออฟไลน์เป็นรอส่ง จนกว่าบริษัทจะยืนยัน';$('loginTitle').textContent='เข้าสู่ระบบ';$('loginButton').textContent='เข้าสู่ระบบ';$('loginHint').textContent='ใช้บัญชีพนักงานที่ได้รับสิทธิ์ในสาขานี้';$('passwordGroup').classList.remove('hidden');$('password').required=true;$('commissionLabel').textContent='ค่าคอมยืนยันเดือนนี้';}
    try{if(localStorage.getItem('mockSales') || localStorage.getItem('mockCheckInStatus'))$('legacyNotice').classList.remove('hidden');}catch(_){/* Legacy storage may be disabled; IndexedDB remains authoritative. */}
    if(services.remote && config.auth?.observe)config.auth.observe(user=>{if(state.user && (!user || user.uid!==state.user.uid))resetUser();});
    setInterval(()=>{if(state.user && document.visibilityState==='visible'){void refreshAttendance().catch(e=>message('menuStatus',errorText(e),true));void sync();}},30000);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
