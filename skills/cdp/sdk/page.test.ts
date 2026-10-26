import assert from 'node:assert/strict';
import test from 'node:test';
import { Browser, Page } from './browser.ts';
import type { Session } from './session.ts';

const origin = 'https://allowed.test';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class Transport {
  generation = 1;
  connected = true;
  url = `${origin}/`;
  redirect?: string;
  iframe = false;
  children: {id:string;loaderId:string;url:string}[] = [];
  calls: {method:string;params:any;sid?:string}[] = [];
  listeners = new Set<(method:string, params:any, sid?:string)=>void>();
  before?: (method:string, params:any)=>Promise<void> | void;
  getConnectionGeneration() { return this.generation; }
  isConnected() { return this.connected; }
  onEvent(fn:(method:string, params:any, sid?:string)=>void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(method:string, params:any = {}, sid = 'main') { for (const fn of this.listeners) fn(method, params, sid); }
  close() { this.connected = false; this.generation++; this.emit('Session.connectionChanged'); }
  async _call(method:string, params:any, options:{sessionId?:string;expectedGeneration?:number} = {}):Promise<any> {
    assert.equal(options.expectedGeneration, this.generation, 'every request is generation fenced');
    assert.ok(this.connected);
    this.calls.push({method,params,sid:options.sessionId});
    await this.before?.(method, params);
    switch (method) {
      case 'Target.createTarget': return {targetId:'tab'};
      case 'Target.attachToTarget': return {sessionId:params.targetId === 'child' ? 'child-session' : 'main'};
      case 'Target.detachFromTarget': return {};
      case 'Target.closeTarget': this.emit('Target.detachedFromTarget', {sessionId:'main'}); return {success:true};
      case 'Target.getTargets': return {targetInfos:this.iframe ? [{type:'iframe',targetId:'child',url:`${origin}/child`}] : []};
      case 'DOM.getFrameOwner': return {backendNodeId:8};
      case 'Page.getFrameTree': return {frameTree:{frame:{id:'frame',loaderId:'loader',url:this.url},
        childFrames:options.sessionId === 'main' ? this.children.map(frame => ({frame:{...frame,parentId:'frame'}})) : []}};
      case 'Page.enable': case 'Page.setLifecycleEventsEnabled': return {};
      case 'Page.navigate':
        this.url = this.redirect ?? params.url;
        this.emit('Page.frameNavigated', {frame:{id:'frame',url:this.url}});
        this.emit('Page.lifecycleEvent', {name:'load',loaderId:'loader'});
        return {loaderId:'loader'};
      case 'Accessibility.getFullAXTree': return {nodes:[{nodeId:'root',ignored:false,backendDOMNodeId:1,role:{type:'role',value:'RootWebArea'},name:{type:'string',value:'Fixture'}}]};
      case 'Runtime.evaluate': return {result:{value:{url:this.url,title:'Fixture'}}};
      default: throw new Error(`Unexpected method ${method}`);
    }
  }
}
function setup() {
  const transport = new Transport();
  const page = new Page(transport as unknown as Session, {sessionId:'main',targetId:'tab',allowedOrigins:[origin]});
  return {transport,page};
}

test('deadlines quarantine pending dispatch; timed-out queued work never dispatches and navigation is never replayed', async () => {
  const {transport,page} = setup(), held = gate(), started = gate();
  transport.before = async method => { if (method === 'Page.navigate') { started.release(); await held.promise; } };
  const first = page.goto(`${origin}/one`, {timeoutMs:60});
  await started.promise;
  const second = page.goto(`${origin}/two`, {timeoutMs:30});
  assert.equal((await first).status, 'outcome_unknown');
  assert.equal((await second).status, 'blocked');
  assert.equal(transport.calls.filter(c=>c.method==='Page.navigate').length, 1);
  held.release(); await tick();
  assert.equal(transport.calls.filter(c=>c.method==='Page.navigate').length, 1);
  transport.before = undefined;
  assert.equal((await page.goto(`${origin}/three`)).status, 'executed');
  assert.equal(transport.calls.filter(c=>c.method==='Page.navigate').length, 2);
  page.dispose();
});

test('snapshot timeout releases an attachment that completes after cancellation', async () => {
  const {transport,page} = setup(), held = gate(), started = gate();
  transport.iframe = true;
  transport.before = async method => { if (method === 'Target.attachToTarget') { started.release(); await held.promise; } };
  const shot = page.snapshot({timeoutMs:40});
  const rejected = assert.rejects(shot, /timed out/);
  await started.promise; await rejected;
  assert.equal(transport.calls.filter(c=>c.method==='Target.detachFromTarget').length,0);
  held.release(); await tick();
  assert.ok(transport.calls.some(c=>c.method==='Target.detachFromTarget'&&c.params.sessionId==='child-session'));
  page.dispose();
});

test('bounded signals and modal info are page scoped; disposed and reconnected pages cannot dispatch', async () => {
  const {transport,page} = setup();
  transport.emit('Page.javascriptDialogOpening', {type:'alert',message:'Other tab'}, 'other');
  assert.equal(page.signals().events.length,0);
  for(let i=0;i<70;i++) transport.emit('Page.javascriptDialogOpening', {type:'alert',message:`Message ${i}`});
  const signals=page.signals();assert.equal(signals.events.length,64);assert.equal(signals.dropped,6);
  assert.equal(page.signals().events.length,0);
  assert.deepEqual(await page.info(),{dialog:{type:'alert',message:'Message 69'}});
  assert.equal(transport.calls.filter(c=>c.method==='Runtime.evaluate').length,0);
  transport.url='https://denied.test/';await assert.rejects(page.info(),/origin_denied/);
  transport.generation++;transport.emit('Session.connectionChanged');
  assert.equal(page.disposed,true);assert.equal(transport.listeners.size,0);
  const count=transport.calls.length;
  await assert.rejects(page.snapshot(),/disposed/);await assert.rejects(page.info(),/disposed/);
  assert.equal(transport.calls.length,count);
});

test('close tolerates its own detach event; disposal releases only owned attachments and is idempotent', async () => {
  const {transport,page}=setup();await page.close();assert.equal(page.disposed,true);assert.equal(transport.listeners.size,0);
  assert.equal(transport.calls.filter(c=>c.method==='Target.detachFromTarget').length,0,'borrowed attachment is not detached');
  const browser=new Browser(transport as unknown as Session);
  const owned=await browser.attach('tab',{allowedOrigins:[origin]});owned.dispose();owned.dispose();await tick();
  assert.equal(transport.calls.filter(c=>c.method==='Target.detachFromTarget').length,1);
  assert.equal(transport.listeners.size,0);
  browser.disconnect();
});

test('concurrent browser acquisitions are bounded before dispatch; invalid policy acquires nothing', async () => {
  const transport=new Transport(), browser=new Browser(transport as unknown as Session), held=gate();
  await assert.rejects(browser.attach('tab',{allowedOrigins:[`${origin}/path`]}));assert.equal(transport.calls.length,0);
  transport.before=async method=>{if(method==='Target.attachToTarget')await held.promise;};
  const acquisitions=Array.from({length:33},()=>browser.attach('tab',{allowedOrigins:[origin]}));
  const results=Promise.allSettled(acquisitions);
  await tick();assert.equal(transport.calls.filter(c=>c.method==='Target.attachToTarget').length,32);
  held.release();const settled=await results;
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,32);
  const rejected=settled.find(r=>r.status==='rejected');assert.match((rejected as PromiseRejectedResult).reason.message,/capacity/);
  browser.disconnect();assert.equal(transport.listeners.size,0);
});

test('browser open cleans up denied redirects; late attachment cannot survive a new generation', async () => {
  const transport=new Transport(),browser=new Browser(transport as unknown as Session);
  transport.redirect='https://denied.test/';
  await assert.rejects(browser.open(origin,{allowedOrigins:[origin]}),/origin_denied/);
  assert.ok(transport.calls.some(c=>c.method==='Target.closeTarget'));
  assert.equal(transport.listeners.size,0);
  transport.before=method=>{if(method==='Target.attachToTarget'){transport.generation++;transport.emit('Session.connectionChanged');}};
  const before=transport.calls.filter(c=>c.method==='Page.enable').length;
  await assert.rejects(browser.attach('tab',{allowedOrigins:[origin]}),/disconnected/);
  assert.equal(transport.calls.filter(c=>c.method==='Page.enable').length,before);
  assert.equal(transport.listeners.size,0);browser.disconnect();
});

test('denied frames are omitted without counting toward the readable frame limit', async () => {
  const {transport,page}=setup();
  // Cross-origin ads and trackers: listed as omissions, never read, never counted.
  transport.children=Array.from({length:40},(_,i)=>({id:`ad${i}`,loaderId:`ad-loader${i}`,url:`https://ads.denied.test/${i}`}));
  const shot=await page.snapshot();
  assert.equal(shot.omissions.filter(o=>o.endsWith('origin_denied')).length,40);
  assert.equal(shot.truncated,true);
  transport.children=Array.from({length:64},(_,i)=>({id:`own${i}`,loaderId:`own-loader${i}`,url:`${origin}/frame${i}`}));
  await assert.rejects(page.snapshot(),/Frame count exceeds 64/);
  transport.children.pop();
  assert.equal((await page.frames()).frames.length,64);
  page.dispose();
});
