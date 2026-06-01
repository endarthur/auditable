import { buildIndex } from '../src/index.js';
import { buildCsrIndex } from '../src/csr.js';
import { search } from '../src/search.js';
const VOCAB=(()=>{const o=[],ab='abcdefghijklmnopqrstuvwxyz';let s=12345;const r=()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff};for(let i=0;i<30000;i++){const n=4+Math.floor(r()*6);let w='';for(let j=0;j<n;j++)w+=ab[Math.floor(r()*26)];o.push(w)}return o})();
function rng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff}}
function corpus(n,bw){const r=rng(42),pick=()=>VOCAB[Math.floor(r()*r()*VOCAB.length)];return Array.from({length:n},(_,i)=>({id:'d'+i,title:Array.from({length:6},pick).join(' '),body:Array.from({length:bw},pick).join(' ')}))}
function mem(){if(global.gc){global.gc();global.gc()}const m=process.memoryUsage();return(m.heapUsed+m.arrayBuffers)/1048576}
function run(n,bw,tag){const docs=corpus(n,bw);const w=VOCAB[0];console.log(`\n## ${tag} n=${n} ~${bw}w`);
  if(!(bw>100&&n>=50000)){const m0=mem(),t0=performance.now();let v1=buildIndex({docs,fields:{title:{boost:4},body:{boost:1}}});const b=performance.now()-t0,ram=mem()-m0;v1=null;console.log(`v1            build ${b.toFixed(0)}ms  RAM ${ram.toFixed(0)}MB`)}else console.log('v1            skipped (OOM)');
  {const m0=mem(),t0=performance.now();const idx=buildCsrIndex({docs,mode:'folded',fields:{title:{boost:4},body:{boost:1}},storeText:false,positions:false});const b=performance.now()-t0,ram=mem()-m0;const ts=performance.now();for(let k=0;k<20;k++)search(idx,w,{fuzzy:1,limit:10});const s=(performance.now()-ts)/20;console.log(`csr folded    build ${b.toFixed(0)}ms  RAM ${ram.toFixed(0)}MB  search ${s.toFixed(2)}ms  V=${idx.V} nnz=${idx.postDocs.length}`)}}
run(50000,40,'EXCERPTS');run(10000,600,'FULL BODIES');run(50000,600,'FULL BODIES');
