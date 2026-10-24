'use strict';
const fs=require('fs'), vm=require('vm'), assert=require('assert');
const source=fs.readFileSync(process.env.SMOOTHER_SOURCE || require('path').join(__dirname, '..', 'ChatGPT-Long-Chat-Smoother.user.js'), 'utf8');
const exposed=source.replace(/\n\}\)\(\);\s*$/, '\n window.__TEST__ = {scan, queueScan, changeSetting, restoreAll, revealOlder, suspendBackground, get:()=>({latestCount,foldedCount,lastState,currentLayout,perf,managed:managed.size,blocks:largeManaged.size,scanJob})};\n})();');
assert(exposed.includes('window.__TEST__'));
class El {
 constructor(tagName='SECTION', text='') { this.tagName=tagName; this.textContent=text; this.isConnected=true; this.nodeType=1; this.parentElement=null;this.children=[];this.queryNodes=[];this._attrs=new Map();this.scrollHeight=11000;this.scrollTop=10000;this.clientHeight=1000;this._classes=new Set();this.classList={add:(...cs)=>cs.forEach(c=>this._classes.add(c)),remove:(...cs)=>cs.forEach(c=>this._classes.delete(c)),contains:c=>this._classes.has(c)}; }
 setAttribute(k,v){this._attrs.set(k,v)}removeAttribute(k){this._attrs.delete(k)}contains(node){return node===this||this.children.some(child=>child.contains(node))}
 getBoundingClientRect(){return {top:500,left:0,width:1024,height:120}}
 querySelectorAll(selector) {if(selector.includes('section[data-testid'))return this.children; if(selector==='[data-turn-key]')return this.children;if(selector.includes('pre, table'))return this.queryNodes;return [];}
 querySelector(selector){if(selector==='[data-turn-key]')return this.children[0]??null;return null}
 closest(){return null}matches(){return false}
}
function scenario(kind){
 const tasks=[], canceled=new Set();let taskId=0,tick=10000, fakeHidden=kind==='hidden', streamed=kind==='stream';
 const n=kind==='blocks'?10:80;
 const root=new El('MAIN'), turns=Array.from({length:n},()=>new El());root.children=turns;turns.forEach(t=>t.parentElement=root);
 const large=new El('PRE','x'.repeat(1600));large.parentElement=turns[2]; turns[2].queryNodes=[large];turns[2].children=[large];
 const scrollRoot=new El('HTML');scrollRoot.scrollTop=11000;scrollRoot.scrollHeight=12000;scrollRoot.clientHeight=1000;
 const classes=()=>({auto:turns.filter(t=>t.classList.contains('cgpt-smoother-v1-auto')).length,fold:turns.filter(t=>t.classList.contains('cgpt-smoother-v1-folded')).length,blocks:[large].filter(t=>t.classList.contains('cgpt-smoother-v1-block')).length});
 const listeners={};const doc={readyState:'loading',addEventListener:(name,fn)=>{listeners[name]=fn;},activeElement:null, scrollingElement:scrollRoot, hidden:fakeHidden,elementFromPoint:()=>turns[77]||turns[5],querySelectorAll:()=>[],querySelector:(s)=>{
  if(s.includes('stop-button'))return streamed?new El():null;
  if(s==='[data-thread-find-target="conversation"]')return kind==='native'?root:null;
  if(s==='#thread')return null;
  if(s==='main')return root;
  return null;
 }};
 const stored={enabled:kind!=='disabled',mode:kind==='compact'?'compact':'safe',minimumTurns:50,keepRecent:30,largeBlocks:true};
 const win={CSS:{supports:()=>true},getSelection:()=>({isCollapsed:true}),innerWidth:1024,innerHeight:768};
 const setT=(fn)=>{const id=++taskId;tasks.push({id,fn});return id};
 win.requestIdleCallback=(fn)=>setT(()=>fn({timeRemaining:()=>6}));win.cancelIdleCallback=id=>canceled.add(id);
 const context={window:win, document:doc,location:{pathname:'/c/test',search:''},performance:{now:()=>{tick+=0.02;return tick}},localStorage:{getItem:()=>JSON.stringify(stored),setItem:()=>{}},Element:El,MutationObserver:class{observe(){}disconnect(){}},getComputedStyle:()=>({overflowY:'visible'}),requestAnimationFrame:fn=>setT(()=>fn(tick)),setTimeout:setT,clearTimeout:id=>canceled.add(id),console,PerformanceObserver:undefined};
 vm.createContext(context);vm.runInContext(exposed,context,{filename:'smoother.user.js'});
 const api=win.__TEST__;
 function flush(max=10000){let i=0;while(tasks.length){assert(i++ <max,kind+' event loop runaway');const t=tasks.shift();if(!canceled.has(t.id))t.fn();} }
 function run(){api.scan();flush();return classes();}
 return {api,doc,root,turns,large,scrollRoot,classes,flush,run, setStreaming:v=>{streamed=v}, setHidden:v=>{doc.hidden=v}};
}
const expect = (actual,expected,msg)=>assert.deepStrictEqual(actual,expected,msg);
{
 const q=scenario('safe');expect(q.run(),{auto:50,fold:0,blocks:1},'safe optimizer');
 assert.strictEqual(q.api.get().scanJob,null,'job finished');
 assert(q.api.get().perf.scans>=1);assert(q.api.get().perf.lastWorkMs>=0);
 console.log('safe: PASS',q.classes(),q.api.get().perf.scans,'scans');
}
{
 const q=scenario('compact');expect(q.run(),{auto:0,fold:50,blocks:0},'compact');
 q.api.revealOlder();q.flush();expect(q.classes(),{auto:0,fold:30,blocks:0},'reveal older');
 q.api.restoreAll();expect(q.classes(),{auto:0,fold:0,blocks:0},'show all');
 q.api.changeSetting('mode','safe');q.flush();expect(q.classes(),{auto:50,fold:0,blocks:1},'switch to safe');
 q.api.changeSetting('enabled',false);q.flush();expect(q.classes(),{auto:0,fold:0,blocks:0},'disabled clean');
 console.log('compact/reveal/restore/settings: PASS');
}
{
 const q=scenario('blocks');expect(q.run(),{auto:0,fold:0,blocks:1},'large block in small chat');
 q.api.changeSetting('largeBlocks',false);q.flush();expect(q.classes(),{auto:0,fold:0,blocks:0},'blocks off');
 console.log('large reply optimization: PASS');
}
{
 const q=scenario('native');expect(q.run(),{auto:0,fold:0,blocks:0},'native bypass');
 console.log('modern layout safety: PASS');
}
{
 const q=scenario('stream');expect(q.run(),{auto:0,fold:0,blocks:0},'stream paused');
 // Clear stream and ensure resume works.
 q.setStreaming(false);q.api.queueScan(0);q.flush();expect(q.classes(),{auto:50,fold:0,blocks:1},'stream ends resume');
 console.log('streaming pause: PASS');
}
{
 const q=scenario('hidden');expect(q.run(),{auto:0,fold:0,blocks:0},'hidden paused');
 q.setHidden(false);q.api.queueScan(0);q.flush();expect(q.classes(),{auto:50,fold:0,blocks:1},'tab resumes');
 console.log('background suspension: PASS');
}
{
 const q=scenario('safe');q.run();q.api.changeSetting('mode','compact');q.flush();
 q.doc.hidden=true;q.api.suspendBackground();const state=q.api.get();
 assert.strictEqual(state.scanJob,null);console.log('in-flight cancellation: PASS');
}
{
 const q=scenario('safe');q.api.scan();
 assert(q.classes().auto<=24,'budget first pass limits mutations');
 assert(q.api.get().scanJob,'job still queued after first chunk');
 q.flush();expect(q.classes(),{auto:50,fold:0,blocks:1},'remaining chunks finish');
 console.log('bounded chunks: PASS');
}
{
 const q=scenario('safe');q.turns[0].querySelectorAll=()=>{throw new Error('simulated DOM failure');};
 q.run();expect(q.classes(),{auto:0,fold:0,blocks:0},'fail-open rollback');
 assert(q.api.get().lastState.startsWith('Safety fallback'));
 console.log('DOM failure restoration: PASS');
}