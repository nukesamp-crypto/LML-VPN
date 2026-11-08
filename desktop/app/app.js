'use strict';
(() => {
  const $ = (sel, parent=document) => parent.querySelector(sel);
  const $$ = (sel, parent=document) => [...parent.querySelectorAll(sel)];
  const defaultSettings={engine:'shiro',systemProxy:true,autoStart:false,cdnIPs:'',sniNames:'',region:'',lanternTag:''};
  let previewSettings={...defaultSettings};
  try { previewSettings={...defaultSettings,...JSON.parse(localStorage.getItem('lml-preview-settings')||'{}')}; } catch {}
  const platform=window.lml?.platform || (window.LMLNative ? 'android' : 'preview');
  const demoSnapshot=()=>({platform:'preview',settings:{...previewSettings},shiro:{state:'preview',detail:'پیش‌نمایش؛ اتصال واقعی در مرورگر ممکن نیست.'},lantern:{state:'preview',detail:'پیش‌نمایش؛ اتصال واقعی در مرورگر ممکن نیست.'},version:'1.0.0'});
  const invoke = async (method,data={}) => {
    if(window.lml?.invoke) return window.lml.invoke(method,data);
    if(window.LMLNative){
      const result=JSON.parse(window.LMLNative.invoke(method,JSON.stringify(data)));
      if(!result.ok) throw new Error(result.error || 'عملیات انجام نشد.');
      return result.value;
    }
    switch(method){
      case 'snapshot': return demoSnapshot();
      case 'selectEngine': previewSettings.engine=data.engine; break;
      case 'saveSettings': previewSettings={...previewSettings,...data}; break;
      case 'selectServer': previewSettings.lanternTag=data.tag; break;
      case 'servers': return [];
      case 'openLink': throw new Error('لینک‌ها در پیش‌نمایش غیرفعال‌اند.');
      default: throw new Error('این فقط پیش‌نمایش رابط است؛ برای اتصال، برنامهٔ واقعی لازم است.');
    }
    try { localStorage.setItem('lml-preview-settings',JSON.stringify(previewSettings)); } catch {}
    return demoSnapshot();
  };
  let snap=null, hydrated=false, timer, allServers=[], serverLoaded=false, serverLoading=false, serverError='', actionBusy=false, countrySignature='', nextServerRetry=0, serverRetries=0;
  let activePage='home', configData={items:[],note:'',refreshing:false}, selectedConfig='', connectionTarget='engine', probeState={running:false,done:0,total:0};
  let scanStartPending=false,scanStopPending=false,scanEpoch=0,scanBeforeRequest=null;
  const CONFIG_PAGE_SIZE=50;let configPage=0,configRowsSignature='';
  let feedCreditTimer=null,clockSince=null,clockFallback=null;
  const headings={home:['آزادی، فقط یک لمس فاصله داره.','موتورت رو انتخاب کن و به اینترنت دلخواهت وصل شو.'],engines:['آی‌پی شیر و خورشید','آدرس‌های شیر و خورشید و تنظیمات موتورهای اتصال.'],settings:['همه‌چیز همون‌طور که تو می‌خوای.','تنظیمات برنامه رو شخصی‌سازی کن.'],feed:['تلگرام (The Feed)','TheFeed؛ کانال‌ها و پیام‌ها در همین پنجره.'],configs:['کانفیگ و زنجیره','کانفیگ‌های تلگرام با میرور TheFeed از طریق Google و آزمایش‌شده با اینترنت فعلی.'],credits:['با سپاس از سازندگان متن‌باز','']};
  function toast(message,error=false){
    const el=$('#toast'); el.textContent=message; el.classList.toggle('error',error); el.classList.add('show');
    clearTimeout(timer); timer=setTimeout(()=>el.classList.remove('show'),4200);
  }
  function message(err){
    let m=String(err?.message||err||'خطایی رخ داد.');
    if(m.includes('Error: '))m=m.substring(m.lastIndexOf('Error: ')+7);
    return m.length>260 ? m.slice(0,260)+'…' : m;
  }
  function feedBounds(){const r=$('#feed-viewport').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
  function syncFeed(){if(activePage==='feed' && platform==='windows')void invoke('feedPosition',{bounds:feedBounds()}).catch(()=>{});}
  function go(page){
    if(!headings[page])return;
    if(activePage==='feed' && page!=='feed' && platform==='windows'){clearTimeout(feedCreditTimer);$('#feed-credit').classList.add('hidden');void invoke('hideFeed').catch(()=>{});}
    activePage=page;
    $$('.page').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
    $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.nav===page));
    $('#page-heading').textContent=headings[page][0]; $('#page-subheading').textContent=headings[page][1];
    document.querySelector('.main').scrollTo?.({top:0,behavior:'smooth'}); window.scrollTo({top:0,behavior:'smooth'});
    if(page==='feed' && platform==='windows'){
      clearTimeout(feedCreditTimer);$('#feed-credit').classList.remove('hidden');
      // Keep attribution visible for two seconds before placing the embedded view.
      feedCreditTimer=setTimeout(()=>{if(activePage==='feed'){$('#feed-credit').classList.add('hidden');void invoke('openFeed',{bounds:feedBounds()}).catch(e=>feedStatus({state:'error',message:message(e)}));}},2000);
    }

  }
  function feedStatus(st){
    const failed=st?.state==='error';$('#feed-message').textContent=failed?(st.message||'راه‌اندازی TheFeed ممکن نشد.'):'در حال آماده‌سازی TheFeed…';
    $('#feed-retry').classList.toggle('hidden',!failed);
  }
  window.lml?.onFeedStatus?.(feedStatus);
  window.addEventListener('resize',syncFeed);window.addEventListener('scroll',syncFeed,true);
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(syncFeed).observe($('#feed-viewport'));
  function engineName(e){return e==='lantern'?'لنترن':'شیر و خورشید';}
  const connectionStates=['connected','connecting','restarting','disconnecting'];
  function currentEngine(s){return s.settings.engine==='shiro'?s.shiro:s.lantern;}
  function showConfig(s){
    if(['connected','connecting','disconnecting'].includes(s.configConnection?.state))return true;
    // An already running engine remains visible until it is disconnected. A
    // selected config must otherwise stay the next explicit connection intent.
    return platform==='windows'&&connectionTarget==='config'&&!connectionStates.includes(currentEngine(s)?.state);
  }
  function stateInfo(s){
    if(platform==='preview')return {title:'پیش‌نمایش برنامه',top:'پیش‌نمایش',detail:'این صفحه اتصال واقعی ندارد.',kind:'preview'};
    const activeConfig=['connected','connecting','disconnecting'].includes(s.configConnection?.state);
    const showSelected=showConfig(s);
    let current=showSelected?(s.configConnection||{state:'disconnected'}):currentEngine(s);
    if(showSelected&&!activeConfig&&current.state==='error'&&current.id&&current.id!==selectedConfig)current={state:'disconnected'};
    if(showSelected&&!activeConfig&&current.state==='disconnected')return {title:selectedConfig?'کانفیگ انتخاب شد':'کانفیگ انتخاب نشده',top:'قطع',detail:selectedConfig?'برای اتصال با کانفیگ انتخاب‌شده، دکمهٔ اتصال را بزن.':'ابتدا یک کانفیگ را انتخاب کن.',kind:'disconnected'};
    const map={disconnected:['قطع هستی','قطع'],connected:['متصل هستی','متصل'],connecting:['در حال اتصال','در حال اتصال'],disconnecting:['در حال قطع اتصال','در حال قطع'],restarting:['در حال اتصال مجدد','در حال اتصال'],unavailable:['سرویس در دسترس نیست','خطای سرویس'],error:['اتصال برقرار نشد','خطا'],unknown:['وضعیت نامشخص','نامشخص']};
    if(activeConfig && current?.state==='connected' && current.tested!==true){
      const failed=current.tested===false;
      return {title:failed?'آزمون مسیر ناموفق بود':'در حال بررسی مسیر',top:failed?'بررسی مسیر':'در حال بررسی',detail:current.detail||'',kind:failed?'config-warning':'config-checking'};
    }
    const pair=map[current?.state]||map.unknown;
    return {title:pair[0],top:pair[1],detail:current?.detail||'',kind:current?.state||'unknown'};
  }
  function hydrate(s){
    if(!s?.settings)return;
    $('#cdn-ips').value=s.settings.cdnIPs||'';
    $('#auto-start').checked=!!s.settings.autoStart; $('#system-proxy').checked=!!s.settings.systemProxy;
    $('#routing-preset').value=s.settings.routingPreset||'global';$('#routing-custom').value=s.settings.routingCustom||'';hydrated=true;
  }
  function renderClock(){
    const seconds=clockSince===null?0:Math.max(0,Math.floor((Date.now()-clockSince)/1000));
    const fmt=n=>String(n).padStart(2,'0');
    $('#connection-timer').textContent=`${fmt(Math.floor(seconds/3600))}:${fmt(Math.floor(seconds/60)%60)}:${fmt(seconds%60)}`;
  }
  function updateMetrics(s,info,configActive){
    const current=configActive?s.configConnection:(s.settings.engine==='shiro'?s.shiro:s.lantern);
    if(info.kind==='connected'){
      if(clockFallback===null)clockFallback=Date.now();
      const reported=Number(current?.connectedAt);clockSince=Number.isFinite(reported)&&reported>0&&reported<=Date.now()?reported:clockFallback;
    }else{clockSince=null;clockFallback=null;}
    const ms=current?.pingMs;
    $('#connection-ping').textContent=info.kind==='connected'&&Number.isFinite(ms)&&ms>=0?`${Math.round(ms)} ms`:'—';
    $('#connection-ping').title=ms===-1?'آزمون HTTPS ناموفق بود.':(current?.pingSource==='lantern'?'آخرین زمان پاسخ گزارش‌شده توسط موتور لنترن؛ نه پینگ ICMP':current?.pingSource==='system'?'زمان پاسخ HTTPS سیستم هنگام اتصال لنترن؛ بسته به قوانین مسیریابی ممکن است مستقیم باشد.':'زمان پاسخ HTTPS از مسیر اتصال؛ نه پینگ ICMP');
    renderClock();
  }
  function clockTick(){renderClock();setTimeout(clockTick,1000);}
  setTimeout(clockTick,1000);
  function update(s){
    if(!s?.settings)return; snap=s; if(!hydrated)hydrate(s);
    if(platform==='android' && s.lantern?.serversReady && Array.isArray(s.lantern.servers)) {
      allServers=s.lantern.servers; serverLoaded=true; serverLoading=false; serverError='';
    } else if(platform==='android' && serverLoading && s.lantern?.state==='error') {
      serverLoading=false; serverError='فهرست لنترن در دسترس نیست؛ دوباره تلاش کن.';
    }
    const engine=s.settings.engine, info=stateInfo(s), configActive=['connected','connecting','disconnecting'].includes(s.configConnection?.state), configDisplayed=showConfig(s);
    $$('[data-engine]').forEach(el=>el.classList.toggle('active',el.dataset.engine===engine&&!configDisplayed));
    $('#selected-engine-mini').textContent=configDisplayed?(selectedConfig||configActive?'کانفیگ · Xray':'کانفیگ · انتخاب کن'):engineName(engine);
    $('#state-title').textContent=info.title; $('#state-detail').textContent=info.detail;
    $('#top-status').lastChild.textContent=info.top;
    const stateStyle=info.kind==='connected'?'connected':(info.kind==='config-warning'?'config-warning':(['connecting','restarting','config-checking'].includes(info.kind)?'connecting':''));
    $('#top-status').className='status-pill '+stateStyle;
    $('#state-dot').className='state-dot '+stateStyle;
    const power=$('#power-button');
    power.classList.toggle('is-connected',info.kind==='connected');
    power.classList.toggle('is-warning',info.kind==='config-warning');
    power.classList.toggle('is-busy',['connecting','disconnecting','restarting','config-checking'].includes(info.kind));
    power.setAttribute('aria-label',['connected','connecting','restarting','config-warning','config-checking'].includes(info.kind)?'قطع اتصال':'اتصال');
    power.disabled=actionBusy || info.kind==='disconnecting';
    $('#scope-label').textContent=configDisplayed?'پراکسی کانفیگ':(platform==='android'?'VPN دستگاه':(engine==='lantern'?'سرویس داخلی لنترن':(s.settings.systemProxy?'پراکسی سیستم':'پراکسی محلی')));
    if(!configDisplayed && platform==='windows' && engine==='shiro' && s.shiro?.state==='connected' && !s.settings.systemProxy && s.shiro.httpPort){
      $('#state-detail').textContent=`پراکسی محلی HTTP: 127.0.0.1:${s.shiro.httpPort} — تنظیم سیستم خاموش است.`;
    }
    updateMetrics(s,info,configDisplayed);
    if(s.configProbe)probeState=s.configProbe;renderCountries();renderConfigs();
  }
  async function act(method,data,success){
    if(actionBusy)return null;
    actionBusy=true; if(snap) update(snap);
    try {
      const result=await invoke(method,data);
      if(result?.settings)update(result);
      if(success)toast(success);
      return result;
    } catch(e){toast(message(e),true);return null;}
    finally {actionBusy=false;if(snap)update(snap);}
  }
  function countryName(code,fallback=''){
    try { return new Intl.DisplayNames(['fa'],{type:'region'}).of(code)||fallback||code; }
    catch { return ({DE:'آلمان',NL:'هلند',GB:'بریتانیا',US:'آمریکا',CA:'کانادا',FR:'فرانسه',TR:'ترکیه',SE:'سوئد'})[code]||fallback||code; }
  }
  function renderCountries(force=false){
    if(!snap)return;
    const lantern=snap.settings.engine==='lantern';
    const current=lantern?(snap.settings.lanternTag||''):(snap.settings.region||'');
    const state=(lantern?snap.lantern:snap.shiro)?.state;
    const regions=Array.isArray(snap.shiro?.regions)?snap.shiro.regions:[];
    const signature=JSON.stringify([lantern,current,state,regions,allServers,serverLoaded,serverLoading,serverError,actionBusy]);
    if(!force && signature===countrySignature)return; countrySignature=signature;
    const select=$('#home-region'), hint=$('#country-hint');
    select.replaceChildren();
    const auto=document.createElement('option'); auto.value=''; auto.textContent='انتخاب خودکار'; select.append(auto);
    const labels=new Map();
    if(lantern){
      for(const server of allServers){
        const base=[countryName(server.countryCode,server.country),server.city].filter(Boolean).join(' · ')||'موقعیت نامشخص';
        const n=(labels.get(base)||0)+1; labels.set(base,n);
        const option=document.createElement('option'); option.value=server.tag; option.textContent=base+(n>1?` (${n.toLocaleString('fa-IR')})`:''); select.append(option);
      }
      hint.textContent=serverLoading?'در حال دریافت فهرست واقعی لنترن…':serverError||(!serverLoaded?'فهرست واقعی لنترن را دریافت کن.':(allServers.length?'کشور و شهر از سرورهای فعلی لنترن است.':'هنوز سروری دریافت نشد؛ برنامه خودکار دوباره تلاش می‌کند.'));
    }else{
      const choices=[...new Set(['DE','NL','GB','US','CA','FR','TR',...regions])];
      for(const code of choices){if(!/^[A-Z]{2}$/.test(code))continue;const option=document.createElement('option');option.value=code;option.textContent=countryName(code);select.append(option);}
      hint.textContent='کشور را قبل از اتصال انتخاب کن؛ در دسترس بودن آن به سرورها و شبکه بستگی دارد.';
    }
    if(current && !Array.from(select.options).some(option=>option.value===current)){
      const missing=document.createElement('option');missing.value=current;missing.textContent='انتخاب قبلی در فهرست فعلی نیست';missing.disabled=true;select.append(missing);
    }
    select.value=current;
    select.disabled=actionBusy||['connected','connecting','restarting','disconnecting'].includes(state);
    $('#country-subtitle').textContent=engineName(snap.settings.engine);
    $('#refresh-countries').classList.toggle('hidden',!lantern);
  }
  async function loadLanternServers(showMessage=false){
    if(serverLoading)return;
    serverLoading=true;serverError='';renderCountries(true);
    try{
      const values=await invoke('servers');
      if(!Array.isArray(values))throw new Error('فهرست لنترن نامعتبر بود.');
      allServers=values;
      if(platform!=='android'){
        serverLoaded=true;
        if(values.length){serverRetries=0;nextServerRetry=0;}else{serverRetries++;nextServerRetry=Date.now()+Math.min(30000,4000+serverRetries*2000);}
      }
      if(showMessage && platform!=='android')toast(values.length?`${values.length.toLocaleString('fa-IR')} سرور دریافت شد.`:'هنوز سروری آماده نیست؛ دوباره بررسی می‌شود.');
    }catch(e){serverError='سرویس یا فهرست لنترن در دسترس نیست؛ تلاش خودکار ادامه دارد.';nextServerRetry=Date.now()+15000;if(showMessage)toast(message(e),true);}
    finally{if(platform!=='android' || serverError)serverLoading=false;renderCountries(true);}
  }
  document.addEventListener('click',async event=>{
    const nav=event.target.closest('[data-nav]'); if(nav){go(nav.dataset.nav);return;}
    const wc=event.target.closest('[data-window]'); if(wc && window.lml?.window){window.lml.window(wc.dataset.window);return;}
    const eng=event.target.closest('[data-engine]'); if(eng){
      const result=await act('selectEngine',{engine:eng.dataset.engine});if(result){connectionTarget='engine';update(result);toast(`${engineName(eng.dataset.engine)} انتخاب شد.`);if(eng.dataset.engine==='lantern')void loadLanternServers();}return;
    }
    const link=event.target.closest('[data-link]'); if(link){await act('openLink',{key:link.dataset.link});return;}
  });
  $('#power-button').addEventListener('click',async()=>{
    if(!snap)return;
    const configActive=['connected','connecting','disconnecting'].includes(snap.configConnection?.state);
    const state=currentEngine(snap)?.state;
    if(configActive){await act('configsDisconnect',{});return;}
    // Do not silently replace an already active engine. Its disconnect finishes
    // first, and the following click connects the selected config.
    if(connectionStates.includes(state)){await act('disconnect',{});return;}
    if(platform==='windows'&&connectionTarget==='config'){
      if(!selectedConfig){toast('ابتدا یک کانفیگ را انتخاب کن.',true);return;}
      await act('configsConnect',{id:selectedConfig,mode:$('#config-mode').value});return;
    }
    await act('connect',{});
  });
  $('#save-engine').addEventListener('click',async()=>{
    const data={cdnIPs:$('#cdn-ips').value,sniNames:''};
    const r=await act('saveSettings',data,'تنظیمات ذخیره شد؛ در اتصال بعدی اعمال می‌شود.');if(r?.settings)hydrate(r);
  });
  $('#save-general').addEventListener('click',async()=>{
    const r=await act('saveSettings',{autoStart:$('#auto-start').checked,systemProxy:$('#system-proxy').checked},'تنظیمات ذخیره شد.');if(r?.settings)hydrate(r);
  });
  $('#home-region').addEventListener('change',async event=>{
    if(!snap)return;
    const lantern=snap.settings.engine==='lantern';
    const result=await act(lantern?'selectServer':'saveSettings',lantern?{tag:event.target.value}:{region:event.target.value});
    renderCountries(true);
    if(result)toast('کشور برای اتصال بعدی ذخیره شد.');
  });
  $('#refresh-countries').addEventListener('click',()=>{void loadLanternServers(true);});
  $('#feed-retry').addEventListener('click',async()=>{try{await invoke('retryFeed');}catch(e){feedStatus({state:'error',message:message(e)});}});
  function modeHint(){
    const mode=$('#config-mode').value;
    $('#config-mode-hint').textContent=mode==='psiphon-via-xray'?'سایفون از کانفیگ عبور می‌کند؛ حالت زنجیره فقط پراکسی است و کل سیستم را تونل نمی‌کند.':mode==='xray-via-psiphon'?'کانفیگ از سایفون عبور می‌کند؛ حالت زنجیره فقط پراکسی است و کل سیستم را تونل نمی‌کند.':'کانفیگ مستقیم فقط از پراکسی استفاده می‌کند و کل سیستم را تونل نمی‌کند.';
  }
  function renderConfigs(){
    const all=Array.isArray(configData.items)?configData.items:[];
    const proto=$('#config-protocol-filter').value;
    const list=all.filter(x=>!proto||String(x.scheme).toLowerCase()===proto.toLowerCase());
    if($('#config-sort').value==='latency')list.sort((a,b)=>(a.latency>0?a.latency:Infinity)-(b.latency>0?b.latency:Infinity));
    $('#config-count').textContent=`${all.length.toLocaleString('fa-IR')} مورد`;
    const waitingForNewScan=scanStartPending&&(!configData.scan||configData.scan.id===scanBeforeRequest);
    $('#config-note').textContent=(waitingForNewScan?'در حال آماده‌سازی جست‌وجوی جدید…':(configData.note||'برای پیدا کردن کانفیگ، دکمهٔ پیدا کردن و تست را بزن.'))+(configData.testsWaiting?' آزمون کانفیگ‌ها پس از قطع اتصال فعلی LML ادامه می‌یابد.':'');
    const scanActive=!!(scanStartPending||configData.scanRunning||configData.refreshing||probeState.running);
    $('#config-refresh').disabled=scanActive||scanStopPending;
    const order=new Map(all.map((c,i)=>[c.id,i+1]));
    const pages=Math.max(1,Math.ceil(list.length/CONFIG_PAGE_SIZE));configPage=Math.min(configPage,pages-1);
    $('#config-page').textContent=`صفحهٔ ${(configPage+1).toLocaleString('fa-IR')} از ${pages.toLocaleString('fa-IR')}`;
    $('#config-prev').disabled=configPage===0;$('#config-next').disabled=configPage>=pages-1;
    const pageItems=list.slice(configPage*CONFIG_PAGE_SIZE,(configPage+1)*CONFIG_PAGE_SIZE);
    const signature=JSON.stringify([selectedConfig,configPage,pageItems.map(c=>[c.id,order.get(c.id),c.name,c.scheme,c.network,c.security,c.insecure,c.countryCode,c.countrySource,c.latency])]);
    const target=$('#config-list'),scrollTop=target.scrollTop;
    if(signature!==configRowsSignature){configRowsSignature=signature;target.replaceChildren();
    for(const c of pageItems){
      const row=document.createElement('div');row.className='config-item'+(selectedConfig===c.id?' selected':'');
      const button=document.createElement('button');button.className='config-pick';button.dataset.configId=c.id;button.setAttribute('aria-label',`انتخاب ${c.name} شماره ${order.get(c.id)}، Google`);
      const flag=document.createElement('span');flag.className='config-flag';
      if(/^[A-Z]{2}$/.test(c.countryCode||'')){
        const img=document.createElement('img');img.src=`assets/flags/${c.countryCode.toLowerCase()}.svg`;img.alt=c.countryCode;
        img.addEventListener('error',()=>{flag.textContent='◌';});flag.append(img);
        flag.title=c.countrySource==='ip'?'کشور تقریبی IP ورودی؛ الزاماً کشور خروجی نیست.':'پرچم اعلام‌شده در نام کانفیگ؛ تأیید موقعیت نیست.';
      }else{flag.textContent='◌';flag.title='کشور مشخص نیست';}
      const info=document.createElement('span');info.className='config-item-main';const title=document.createElement('b');title.textContent=c.name;const index=document.createElement('span');index.className='config-index';index.textContent=`#${order.get(c.id)}`;title.append(' ',index);
      const sub=document.createElement('small');sub.textContent=`Google  ·  ${c.network||''} / ${c.security||''}${c.insecure?'  ·  ⚠ TLS':''}`;if(c.insecure)sub.className='unsafe';
      info.append(title,sub);const latency=document.createElement('span');latency.className='latency'+(c.latency===-1?' failed':'');latency.textContent=c.latency===-1?'ناموفق':(Number.isFinite(c.latency)&&c.latency>=0?`${Math.round(c.latency)} ms`:'—');
      const badge=document.createElement('span');badge.className='protocol';badge.textContent=c.scheme;button.append(flag,info,latency,badge);
      const remove=document.createElement('button');remove.className='config-delete';remove.dataset.removeConfig=c.id;remove.type='button';remove.title='حذف کانفیگ';remove.setAttribute('aria-label',`حذف ${c.name} شماره ${order.get(c.id)}`);remove.textContent='×';row.append(button,remove);target.append(row);
    }
    target.scrollTop=scrollTop;}
    const chosen=all.find(x=>x.id===selectedConfig),selected=$('#config-selected');selected.replaceChildren();
    if(chosen){
      const name=document.createElement('strong');name.className='selected-name';name.dir='ltr';name.textContent=`${chosen.name} · #${order.get(chosen.id)}`;
      const source=document.createElement('small');source.className='selected-source';source.textContent='منبع: Google';selected.append(name,source);
    }else selected.textContent='هنوز کانفیگی انتخاب نشده است.';
    const st=snap?.configConnection||{state:'disconnected',detail:'آمادهٔ انتخاب کانفیگ'};
    const isActive=['connecting','connected','disconnecting'].includes(st.state);
    const otherActive=snap&&!isActive&&connectionStates.includes(currentEngine(snap)?.state);
    $('#config-state').textContent=otherActive?'ابتدا اتصال موتور فعلی را قطع کن؛ سپس با کانفیگ انتخاب‌شده وصل شو.':(st.detail||'')+(st.state==='connected'&&Number.isFinite(st.pingMs)&&st.pingMs>=0?` · ${Math.round(st.pingMs)} ms`:'');
    $('#config-connect').textContent=isActive?'قطع اتصال':'اتصال';
    $('#config-connect').disabled=actionBusy||st.state==='disconnecting'||(!isActive&&!chosen);
    $('#config-mode').disabled=isActive;
    $('#config-test-selected').disabled=!chosen||isActive||scanActive||scanStopPending;$('#config-test-all').disabled=!all.length||isActive||scanActive||scanStopPending;
    $('#config-test-stop').classList.toggle('hidden',!scanActive&&!scanStopPending);$('#config-test-stop').disabled=scanStopPending||!!configData.scanStopping;
    $('#config-remove-failed').disabled=!(configData.failedCount>0);
    $('#config-restore').classList.toggle('hidden',!(configData.hiddenCount>0));$('#config-restore').disabled=scanActive||scanStopPending;
    const scan=configData.scan,fa=n=>Number(n||0).toLocaleString('fa-IR');
    if(waitingForNewScan)$('#config-progress').textContent='در حال آماده‌سازی آزمون کانفیگ‌ها…';
    else if((configData.scanRunning||configData.refreshing||!probeState.running)&&scan){
      $('#config-progress').textContent=`کانفیگ‌ها: ${fa(scan.tested)} تست‌شده از ${fa(scan.found)} پیدا یا ذخیره‌شده${scan.skipped?`؛ ${fa(scan.skipped)} حذف‌شده`:''}. فقط اتصال‌های موفق در فهرست نشان داده می‌شوند.`;
    }else if(probeState.running)$('#config-progress').textContent=`تست انتخابی: ${fa(probeState.done)} از ${fa(probeState.total)}`;
    else $('#config-progress').textContent='فقط اتصال موفق نشان داده می‌شود؛ زمان پاسخ HTTPS به شبکه و مقصد آزمون بستگی دارد.';
    modeHint();
  }
  // An older async response must not overwrite a newer pushed snapshot.
  function acceptConfigs(v){
    if(!v||!Array.isArray(v.items))return false;
    if(Number.isFinite(v.revision)&&Number.isFinite(configData.revision)&&v.revision<configData.revision)return false;
    configData=v;return true;
  }
  async function loadConfigs(refresh=false){
    const epoch=refresh?++scanEpoch:scanEpoch;
    if(refresh){scanBeforeRequest=configData.scan?.id??null;scanStartPending=true;renderConfigs();}
    try{const v=await invoke(refresh?'configsRefresh':'configsList');if(epoch===scanEpoch&&acceptConfigs(v))renderConfigs();}
    catch(e){if(epoch===scanEpoch&&refresh)toast(message(e),true);}
    finally{if(refresh&&epoch===scanEpoch){scanStartPending=false;renderConfigs();}}
  }
  window.lml?.onConfigs?.(v=>{if(acceptConfigs(v))renderConfigs();});
  function syncProbe(v){if(v){probeState=v;if(snap)snap.configProbe={...v};}renderConfigs();}
  window.lml?.onConfigProgress?.(syncProbe);
  $('#config-refresh').addEventListener('click',()=>void loadConfigs(true));
  for(const id of ['config-source-filter','config-protocol-filter','config-sort'])$('#'+id).addEventListener('change',()=>{configPage=0;renderConfigs();});
  $('#config-mode').addEventListener('change',renderConfigs);
  $('#config-prev').addEventListener('click',()=>{if(configPage>0){configPage--;$('#config-list').scrollTop=0;renderConfigs();}});
  $('#config-next').addEventListener('click',()=>{configPage++;$('#config-list').scrollTop=0;renderConfigs();});
  $('#config-list').addEventListener('click',async event=>{
    const del=event.target.closest('[data-remove-config]');
    if(del){try{const result=await invoke('configsRemove',{id:del.dataset.removeConfig});if(acceptConfigs(result)){if(selectedConfig===del.dataset.removeConfig)selectedConfig='';if(snap)update(snap);else renderConfigs();}}catch(e){toast(message(e),true);}return;}
    const item=event.target.closest('[data-config-id]');if(item){selectedConfig=item.dataset.configId;connectionTarget='config';if(snap)update(snap);else renderConfigs();}
  });
  $('#config-remove-failed').addEventListener('click',async()=>{
    try{const result=await invoke('configsRemoveFailed');if(acceptConfigs(result)){if(!result.items.some(x=>x.id===selectedConfig))selectedConfig='';if(snap)update(snap);else renderConfigs();toast(`${Number(result.removed||0).toLocaleString('fa-IR')} کانفیگ ناموفق حذف شد.`);}}catch(e){toast(message(e),true);}
  });
  $('#config-restore').addEventListener('click',async()=>{
    try{const result=await invoke('configsRestore');if(acceptConfigs(result)){renderConfigs();}toast('موارد حذف‌شده در جست‌وجوی بعدی بازمی‌گردند.');}catch(e){toast(message(e),true);}
  });
  $('#open-notices').addEventListener('click',async()=>{try{await invoke('openNotices');}catch(e){toast(message(e),true);}});
  $('#routing-save').addEventListener('click',async()=>{const r=await act('saveSettings',{routingPreset:$('#routing-preset').value,routingCustom:$('#routing-custom').value},'مسیریابی برای اتصال بعدی ذخیره شد.');if(r?.settings)hydrate(r);});
  async function testConfigs(all){try{syncProbe(await invoke('configsTest',{all,id:selectedConfig}));}catch(e){toast(message(e),true);}}
  $('#config-test-selected').addEventListener('click',()=>void testConfigs(false));$('#config-test-all').addEventListener('click',()=>void testConfigs(true));
  $('#config-test-stop').addEventListener('click',async()=>{
    ++scanEpoch;scanStartPending=false;scanStopPending=true;renderConfigs();
    try{const result=await invoke('configsTestStop');acceptConfigs(result?.configs);syncProbe(result);}
    catch(e){toast(message(e),true);}
    finally{scanStopPending=false;renderConfigs();}
  });
  $('#config-connect').addEventListener('click',async()=>{
    const active=['connected','connecting','disconnecting'].includes(snap?.configConnection?.state);
    if(!active){connectionTarget='config';if(snap)update(snap);}
    await act(active?'configsDisconnect':'configsConnect',active?{}:{id:selectedConfig,mode:$('#config-mode').value});
  });
  function platformSetup(){
    $('#preview-banner').classList.toggle('hidden',platform!=='preview');
    $('#android-banner').classList.toggle('hidden',platform!=='android');
    $$('.android-only').forEach(e=>e.classList.toggle('hidden',platform!=='android'));
    $$('.win-only').forEach(e=>e.classList.toggle('hidden',platform==='android'));
    if(platform==='android'){
      $('#platform-note').textContent='اندروید · نسخه ۱٫۰٫۰';
      $('#safety-note-text').textContent='برای اتصال هر موتور اجازهٔ VPN اندروید را تأیید کن.';
    } else if(platform==='preview') $('#platform-note').textContent='پیش‌نمایش طراحی';
  }
  platformSetup();
  (async()=>{try{update(await invoke('snapshot'));if(snap?.settings.engine==='lantern')void loadLanternServers();if(platform==='windows')void loadConfigs(false);}catch(e){toast(message(e),true);}})();
  setInterval(async()=>{if(actionBusy)return;try{update(await invoke('snapshot'));if(platform==='windows' && snap?.settings.engine==='lantern' && !serverLoading && !allServers.length && Date.now()>=nextServerRetry)void loadLanternServers();}catch{}},2500);
})();
