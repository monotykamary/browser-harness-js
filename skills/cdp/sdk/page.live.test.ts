import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before, after } from 'node:test';
import { Browser, type PageSnapshot } from './browser.ts';

let chrome: ChildProcess | undefined, server: Server, profile: string, port = 0, origin = '', crossOrigin = '';
const html = () => `<!doctype html><title>Page ergonomics</title><style>body{font:14px sans-serif}iframe{width:300px;height:60px}</style>
<label>Query<input id="query" value="initial"></label><label>Password<input type="password" value="do-not-expose"></label>
<input aria-label="Budget" type="range" value="42"><select aria-label="Cabin"><option>Economy</option><option>Business</option></select>
<div role="group" aria-label="Outbound"><button id="out">Select</button></div><div role="group" aria-label="Return"><button>Select</button></div>
<table aria-label="Fares"><tr><th>Carrier</th><th>Price</th></tr><tr><td>Example Air</td><td>100</td></tr></table>
<p id="status">Not saved</p><button id="save" onclick="document.getElementById('status').textContent='Saved'">Save</button>
<button id="pointer">Pointer only</button><button id="disabled" disabled>Disabled</button><div id="hide" hidden><button>Hidden</button></div>
<iframe src="/child" title="Same frame"></iframe><iframe src="${crossOrigin}/child" title="Cross frame"></iframe>
<shadow-box></shadow-box><div style="height:1800px"></div><button id="below" onclick="document.getElementById('status').textContent='Below clicked'">Below fold</button>
<script>document.getElementById('pointer').addEventListener('pointerdown',()=>document.getElementById('status').textContent='Pointer worked');
customElements.define('shadow-box',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>'}});</script>`;
// Guard shapes from real pages: a native radio made transparent over its drawn ring, a
// disabled button, a sub-menu caret hidden from the accessibility tree and a covered button.
const shapes = () => `<!doctype html><title>Guard shapes</title><body style="margin:16px;font:14px sans-serif">
<span style="position:relative;display:inline-flex;width:16px;height:16px"><input type="radio" name="answer" aria-label="No" style="position:absolute;width:16px;height:16px;margin:0;opacity:0"><span style="pointer-events:none;width:14px;height:14px;border:1px solid #888;border-radius:50%"></span></span><span>No</span>
<button style="opacity:0">Ghost action</button><button disabled>Locked action</button>
<div role="menubar" style="height:30px"><div role="menuitem" tabindex="0" style="display:inline-block">Accounts</div><div id="caret" aria-hidden="true" style="display:inline-block;width:18px;height:18px;cursor:pointer;background:#ccc" onclick="document.getElementById('sub').style.display='block'"></div><div id="sub" role="menu" style="display:none"><div role="menuitem">New Account</div></div></div>
<div style="position:relative;height:40px"><button>Apply now</button><div id="notice" style="position:absolute;inset:0;background:#ffe">Notice</div></div>
</body>`;
// A page whose snapshot exceeds the 50,000-character default.
const large = () => `<!doctype html><title>Catalogue</title>${Array.from({length:1500},(_,i)=>`<p>Catalogue line ${i} with enough words to fill the page</p>`).join('')}
<p id="state">Basket empty</p><button onclick="document.getElementById('state').textContent='Basket checked out'">Checkout</button>`;
// Forty opaque-origin ad frames rendered in the page's own process, plus a readable frame.
const ads = () => `<!doctype html><title>Ads</title><button>Buy</button><iframe src="/child"></iframe>${Array.from({length:40},(_,i)=>`<iframe src="data:text/html,<p>ad ${i}</p>"></iframe>`).join('')}`;
// A login page with an opaque-origin ad frame beside its own button.
const login = () => `<!doctype html><title>Login</title><p id="state">Signed out</p><button onclick="document.getElementById('state').textContent='Signed in'">Sign in</button><iframe src="data:text/html,<button>Ad</button>"></iframe>`;
// Fields a person types into: a text field that counts its key presses, a textarea, native date
// and time controls, a password, a file input drawn as a button, and a sign-in sealed in a closed shadow root.
const typing = () => `<!doctype html><title>Typing</title><body style="margin:16px;font:14px sans-serif">
<label>City <input id="city" value="old value"></label> <label>Notes <textarea id="notes"></textarea></label>
<label>Departure <input id="departure" type="date"></label> <label>Arrival time <input id="arrival" type="time"></label>
<label>Password <input id="pw" type="password"></label>
<span style="position:relative;display:inline-block;width:120px;height:30px"><input type="file" role="button" aria-label="Upload receipt" style="position:absolute;inset:0;width:120px;height:30px;margin:0;opacity:0"><span style="pointer-events:none;display:inline-block;width:118px;height:28px;border:1px solid #888">Upload</span></span>
<p id="keys">0</p><p id="state">Signed out</p><sealed-signin></sealed-signin>
<script>let keys=0;document.getElementById('city').addEventListener('keydown',e=>{if(!e.ctrlKey&&!e.metaKey)document.getElementById('keys').textContent=String(++keys)});
customElements.define('sealed-signin',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'closed'});root.innerHTML='<button>Sealed sign in</button>';root.querySelector('button').addEventListener('click',()=>document.getElementById('state').textContent='Signed in')}});</script>
</body>`;
const routes: Record<string, () => string> = { '/child': () => '<title>Child</title><button>Child button</button>', '/shapes': shapes, '/large': large, '/ads': ads, '/login': login, '/typing': typing };
before(async () => {
  server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end((routes[req.url ?? ''] ?? html)());});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const httpPort=(server.address() as {port:number}).port;
  origin=`http://127.0.0.1:${httpPort}`;crossOrigin=`http://localhost:${httpPort}`;
  const executable=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
  if(!executable)return;
  profile=mkdtempSync(join(tmpdir(),'browser-harness-page-'));
  chrome=spawn(executable,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--window-size=1200,900','--site-per-process','about:blank'],{stdio:'ignore'});
  const file=join(profile,'DevToolsActivePort');
  for(let i=0;i<100&&!existsSync(file);i++)await new Promise(r=>setTimeout(r,100));
  port=Number(readFileSync(file,'utf8').split('\n')[0]);
});
after(async()=>{
  if(chrome&&chrome.exitCode===null){const exited=new Promise(r=>chrome!.once('exit',r));chrome.kill();await exited;}
  await new Promise<void>(r=>server.close(()=>r()));
  if(profile)rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
async function open(origins = [origin,crossOrigin], path = '') {
  const browser=new Browser();await browser.connect({port});
  const page=await browser.open(origin+path,{allowedOrigins:origins,timeoutMs:15000});
  return {browser,page,close:async()=>{await page.close();browser.disconnect();}};
}
const refFor=(snapshot:PageSnapshot,label:string)=>{
  const line=snapshot.tree.split('\n').find(line=>line.includes(JSON.stringify(label))&&line.includes('[ref='));
  assert.ok(line,`Missing ${label}: ${snapshot.tree}`);return line.match(/\[ref=([^\]]+)\]/)![1]!;
};

test('snapshot retains values, table data, named contexts, shadow/offscreen controls, and same/cross-process frames',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open();try{
    const full=await p.page.snapshot();
    assert.match(full.tree,/value="initial"/);assert.match(full.tree,/slider.*value=42/);
    assert.match(full.tree,/cell "Example Air"/);assert.match(full.tree,/cell "100"/);
    assert.match(full.tree,/table "Fares"/);assert.match(full.tree,/group "Outbound"/);
    assert.match(full.tree,/Shadow button/);assert.match(full.tree,/Below fold/);assert.ok(!full.tree.includes('do-not-expose'));
    assert.equal(full.tree.match(/button "Child button"/g)?.length,2,full.tree);
    assert.equal(full.truncated,false,JSON.stringify(full.omissions));
    const again=await p.page.snapshot();assert.equal(again.diff,'(no changes)');
    const scoped=await p.page.snapshot({ref:refFor(again,'Outbound')});assert.match(scoped.tree,/Select/);assert.ok(!scoped.tree.includes('Return'));
    await assert.rejects(p.page.snapshot({ref:refFor(again,'Return')}),/stale_ref/);
    const small=await p.page.snapshot({maxDepth:0});assert.equal(small.truncated,true);
    await assert.rejects(p.page.snapshot({maxChars:10}),/narrow the snapshot/);
  }finally{await p.close();}
});

test('locator actions are strict, guarded, trusted by default, verified, and auto-scroll only through the guard',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open();try{
    assert.equal(p.browser.session.getActiveSession(),undefined);
    const ambiguous=await p.page.getByRole('button',{name:'Select'}).click();assert.equal(ambiguous.status,'blocked');assert.match(ambiguous.reason!,/2 matches/);
    const exact=await p.page.getByRole('button',{name:'Select',context:'group: Outbound'}).click();assert.equal(exact.status,'executed',JSON.stringify(exact));
    const fill=await p.page.getByRole('textbox',{name:'Query'}).fill('new text');assert.equal(fill.status,'executed',JSON.stringify(fill));assert.equal(fill.verified,true);
    const selected=await p.page.getByRole('combobox',{name:'Cabin'}).selectOption('Business');assert.equal(selected.status,'executed',JSON.stringify(selected));assert.equal(selected.verified,true);
    const pointer=await p.page.getByRole('button',{name:'Pointer only'}).click({verify:s=>s.tree.includes('Pointer worked')});assert.equal(pointer.verified,true,JSON.stringify(pointer));
    const save=await p.page.locator('#save').click({verify:s=>s.tree.includes('text: "Saved"')});assert.equal(save.verified,true,JSON.stringify(save));
    const below=await p.page.getByRole('button',{name:'Below fold'}).click({verify:s=>s.tree.includes('Below clicked')});assert.equal(below.status,'executed',JSON.stringify(below));assert.equal(below.verified,true);
    assert.equal(p.browser.session.getActiveSession(),undefined);
    const scoped=await p.page.snapshot({selector:'#query'});assert.match(scoped.tree,/new text/);assert.ok(!scoped.tree.includes('Outbound'));
  }finally{await p.close();}
});

test('old refs and replaced nodes fail closed; disabled/private targets and denied origins never fall back',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin]);try{
    const snapshot=await p.page.snapshot();assert.ok(snapshot.omissions.some(s=>s.includes('origin_denied')));
    const old=p.page.locator(refFor(snapshot,'Save'));
    await p.page.snapshot();assert.equal((await old.click()).status,'stale');
    const fresh=await p.page.snapshot();const replaced=p.page.locator(refFor(fresh,'Save'));
    // External DOM replacement, not page.cdp invalidation, to exercise native identity.
    await p.browser.session._call('Runtime.evaluate',{expression:'document.getElementById("save").outerHTML="<button id=save>Save</button>"'},{sessionId:p.page.scope.sessionId});
    const result=await replaced.click();assert.ok(['stale','blocked'].includes(result.status),JSON.stringify(result));
    assert.equal((await p.page.locator('#disabled').click()).status,'blocked');
    assert.equal((await p.page.getByRole('textbox',{name:'Password'}).fill('x')).status,'blocked');
    assert.equal((await p.page.goto(crossOrigin)).reason,'origin_denied');
    const read=await p.page.snapshot();const childRef=refFor(read,'Child button');
    assert.equal((await p.page.locator(childRef).click()).reason,'frame_actions_unsupported');
  }finally{await p.close();}
});

test('sensitive fields need an explicit host grant; snapshots keep redacting them',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const browser=new Browser();await browser.connect({port});
  const page=await browser.open(origin,{allowedOrigins:[origin,crossOrigin],allowSensitive:true,timeoutMs:15000});
  try{
    const fill=await page.getByRole('textbox',{name:'Password'}).fill('runner-secret');
    assert.equal(fill.status,'executed',JSON.stringify(fill));assert.equal(fill.verified,true);
    assert.ok(!fill.snapshot!.tree.includes('runner-secret'),'the grant does not lift snapshot redaction');
  }finally{await page.close();browser.disconnect();}
});

test('bounded observations remain usable by model-neutral callers; verification captures static text changes',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open();try{
    const seen=await p.page.observe();const target=seen.candidates.find(c=>c.label==='Save')!;assert.ok(target);
    const result=await p.page.act(seen,{targetId:target.id,operation:'click'},{verify:s=>s.tree.includes('text: "Saved"')});
    assert.equal(result.status,'executed');assert.equal(result.verified,true);assert.match(result.snapshot!.tree,/Saved/);
    const replay=await p.page.act(seen,{targetId:target.id,operation:'click'});assert.equal(replay.status,'stale');
    const abort=new AbortController();abort.abort();const cancelled=await p.page.locator('#save').click({signal:abort.signal});assert.equal(cancelled.status,'blocked');
    const two=await p.browser.open(origin,{allowedOrigins:[origin,crossOrigin]});
    try{
      const ownRef=refFor(await p.page.snapshot(),'Save');
      const foreignRef=refFor(await two.snapshot(),'Save');
      assert.notEqual(ownRef,foreignRef,'ref strings cannot alias across Page owners');
      assert.equal((await p.page.locator(foreignRef).click()).status,'stale');
      const other=await two.observe();
      assert.equal((await p.page.act(other,{targetId:other.candidates[0]!.id,operation:'click'})).reason,'scope_mismatch');
    }
    finally{await two.close();}
  }finally{await p.close();}
});

test('a transparent native radio over its drawn ring takes a real click; a transparent button is refused',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/shapes');try{
    const radio=await p.page.getByRole('radio',{name:'No'}).click();
    assert.equal(radio.status,'executed',JSON.stringify(radio));
    assert.match(radio.snapshot!.tree,/radio "No".*\[checked=true\]/);
    const ghost=await p.page.getByRole('button',{name:'Ghost action'}).click();
    assert.equal(ghost.status,'blocked',JSON.stringify(ghost));
  }finally{await p.close();}
});

test('refusals say why and what to do next, and never act',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/shapes');try{
    const ghost=await p.page.getByRole('button',{name:'Ghost action'}).click();
    assert.equal(ghost.status,'blocked');assert.match(ghost.reason!,/^not_interactable_or_unsupported: hidden \(itself\)/);
    const locked=await p.page.getByRole('button',{name:'Locked action'}).click();
    assert.equal(locked.status,'blocked');assert.match(locked.reason!,/^not_interactable_or_unsupported: disabled/);
    const covered=await p.page.getByRole('button',{name:'Apply now'}).click();
    assert.equal(covered.status,'blocked');assert.match(covered.reason!,/covered at its centre by div#notice "Notice"/);
    const caret=await p.page.locator('#caret').click();
    assert.equal(caret.status,'blocked');assert.match(caret.reason!,/^No accessible target for selector: pointer-only: .*\{x:\d+,y:\d+\}/);
    assert.doesNotMatch((await p.page.snapshot()).tree,/New Account/,'a refusal never clicks');
  }finally{await p.close();}
});

test('role locators resolve on pages larger than the snapshot default',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/large');try{
    await assert.rejects(p.page.snapshot(),/Snapshot exceeds 50000 characters/);
    const checkout=await p.page.getByRole('button',{name:'Checkout'}).click({timeoutMs:30000});
    assert.equal(checkout.status,'executed',JSON.stringify(checkout).slice(0,300));
    assert.match((await p.page.snapshot({selector:'#state'})).tree,/Basket checked out/);
  }finally{await p.close();}
});

test('denied ad frames are omitted without counting toward the frame limit',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/ads');try{
    const shot=await p.page.snapshot();
    assert.equal(shot.omissions.filter(o=>o.endsWith('origin_denied')).length,40,JSON.stringify(shot.omissions));
    assert.match(shot.tree,/button "Buy"/);assert.match(shot.tree,/button "Child button"/);
  }finally{await p.close();}
});

test('role locators act on a page whose only omissions are denied frames',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/login');try{
    assert.ok((await p.page.snapshot()).omissions.some(o=>o.endsWith('origin_denied')));
    const signin=await p.page.getByRole('button',{name:'Sign in'}).click({verify:s=>s.tree.includes('Signed in')});
    assert.equal(signin.status,'executed',JSON.stringify(signin).slice(0,300));assert.equal(signin.verified,true);
  }finally{await p.close();}
});

const valueOf=async(p:{browser:Browser,page:{scope:{sessionId:string}}},id:string)=>((await p.browser.session._call('Runtime.evaluate',{expression:`document.getElementById(${JSON.stringify(id)}).value`,returnByValue:true},{sessionId:p.page.scope.sessionId})) as {result:{value:string}}).result.value;

test('fill types like a person: click, select what is there, a key per character; other scripts committed whole; long text pasted',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/typing');try{
    const city=await p.page.getByRole('textbox',{name:'City'}).fill('Hà Nội 東京');
    assert.equal(city.status,'executed',JSON.stringify(city).slice(0,300));assert.equal(city.reason,'typed_keys');assert.equal(city.verified,true);
    assert.equal(await valueOf(p,'city'),'Hà Nội 東京','select-all replaced the old value');
    // H, space, N, i, space: the keyable characters arrive as key presses the page hears.
    assert.equal((await p.browser.session._call('Runtime.evaluate',{expression:'document.getElementById("keys").textContent',returnByValue:true},{sessionId:p.page.scope.sessionId}) as {result:{value:string}}).result.value,'5');
    const long='Xin chào, こんにちは. '.repeat(16);
    const notes=await p.page.getByRole('textbox',{name:'Notes'}).fill(long);
    assert.equal(notes.reason,'pasted',JSON.stringify(notes).slice(0,300));assert.equal(notes.verified,true);assert.equal(await valueOf(p,'notes'),long);
    const departure=await p.page.locator('#departure').fill('05/14/2026');
    assert.equal(departure.status,'executed',JSON.stringify(departure).slice(0,300));assert.equal(departure.expected,'2026-05-14');
    assert.match(departure.reason!,/^(typed_keys|typed_segments_not_accepted: value_set_synthetically)$/);
    assert.equal(departure.verified,true);assert.equal(await valueOf(p,'departure'),'2026-05-14');
    const arrival=await p.page.locator('#arrival').fill('2:30 pm');
    assert.equal(arrival.expected,'14:30');assert.equal(arrival.verified,true);assert.equal(await valueOf(p,'arrival'),'14:30');
    const bad=await p.page.locator('#departure').fill('ngày mai');
    assert.equal(bad.status,'blocked');assert.match(bad.reason!,/^unsupported_value: this date control takes a date such as 2026-05-14$/);
  }finally{await p.close();}
});

test('maskSensitive keeps a granted field\'s value in the page: typed, observed as [masked], never verified by read-back',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const browser=new Browser();await browser.connect({port});
  const page=await browser.open(origin+'/typing',{allowedOrigins:[origin],allowSensitive:true,maskSensitive:true,timeoutMs:15000});
  try{
    const fill=await page.getByRole('textbox',{name:'Password'}).fill('hunter2');
    assert.equal(fill.status,'executed',JSON.stringify(fill).slice(0,300));assert.equal(fill.verified,null);
    assert.ok(!JSON.stringify(fill).includes('hunter2'),'the typed secret never comes back');
    assert.equal((await page.observe()).candidates.find(c=>c.label==='Password')?.value,'[masked]');
    assert.equal(await valueOf({browser,page},'pw'),'hunter2');
  }finally{await page.close();browser.disconnect();}
});

test('a control in a closed shadow root takes a real click; a transparent file input over its drawn button is offered',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/typing');try{
    const signin=await p.page.getByRole('button',{name:'Sealed sign in'}).click({verify:s=>s.tree.includes('Signed in')});
    assert.equal(signin.status,'executed',JSON.stringify(signin).slice(0,300));assert.equal(signin.verified,true);
    assert.ok((await p.page.observe()).candidates.some(c=>c.role==='button'&&c.label==='Upload receipt'));
  }finally{await p.close();}
});
