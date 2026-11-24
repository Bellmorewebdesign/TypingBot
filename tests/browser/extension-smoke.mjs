// Loads the unpacked extension in real Chromium, talks to the real (mock-mode) backend, and drives the panel UI up to
// "plan ready". Needs no Google account. It does not touch Google Docs.
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {chromium}=createRequire(import.meta.url)('playwright');
const token='t'.repeat(32);
const dataDir=mkdtempSync(join(tmpdir(),'tb-'));
const srv=spawn('node',[resolve('server/main.ts')],{env:{...process.env,PAIR_TOKEN:token,MODEL_MODE:'mock'},cwd:dataDir,stdio:'ignore'});
await new Promise(r=>setTimeout(r,1500));
const results=[];const check=(n,ok,x='')=>{results.push(ok);console.log((ok?'PASS ':'FAIL ')+n+(x?'  '+x:''));};
const ext=resolve('extension');
const ctx=await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(),'prof-')),{headless:false,args:['--headless=new','--no-sandbox','--disable-extensions-except='+ext,'--load-extension='+ext]});
try{
  let [sw]=ctx.serviceWorkers();if(!sw)sw=await ctx.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(sw.url()).host;check('manifest loads and the service worker starts',/worker\.js$/.test(sw.url()),sw.url());
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('chrome-extension://'+id+'/panel.html');
  check('panel renders with ELA / English preset label',(await page.locator('#preset option').first().innerText())==='ELA / English');
  await page.fill('#token',token);await page.click('#connect');
  await page.waitForFunction(()=>document.getElementById('msg').textContent==='Connected.',null,{timeout:8000}).catch(()=>{});
  check('connects to the backend with the pairing token (mode badge shows mock)',(await page.locator('#mode').innerText()).includes('mock'),await page.locator('#msg').innerText());
  await page.fill('#token','x'.repeat(32));await page.click('#connect');await page.waitForTimeout(800);
  check('a wrong pairing token is rejected',/Check the pairing token|Connection failed/.test(await page.locator('#msg').innerText()),await page.locator('#msg').innerText());
  check('no uncaught page errors',errors.length===0,errors.join(' | '));
}catch(e){check('smoke crashed',false,e.message);}
await ctx.close();srv.kill();
process.exit(results.every(Boolean)?0:1);
