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
// Forty opaque-origin ad frames rendered in the page's own process, plus a readable frame.
const ads = () => `<!doctype html><title>Ads</title><button>Buy</button><iframe src="/child"></iframe>${Array.from({length:40},(_,i)=>`<iframe src="data:text/html,<p>ad ${i}</p>"></iframe>`).join('')}`;
const routes: Record<string, () => string> = { '/child': () => '<title>Child</title><button>Child button</button>', '/ads': ads };
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

test('denied ad frames are omitted without counting toward the frame limit',async t=>{
  if(!port)return t.skip('Chrome not installed');
  const p=await open([origin],'/ads');try{
    const shot=await p.page.snapshot();
    assert.equal(shot.omissions.filter(o=>o.endsWith('origin_denied')).length,40,JSON.stringify(shot.omissions));
    assert.match(shot.tree,/button "Buy"/);assert.match(shot.tree,/button "Child button"/);
  }finally{await p.close();}
});
