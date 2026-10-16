// Optional real Chromium/Edge UI QA, using a separately installed Playwright.
// Run ui-pilot.mjs first; this script only accepts that owned synthetic fixture.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{chromium}=require(process.env.MOONRESTORE_PLAYWRIGHT||'playwright');
const project=fileURLToPath(new URL('../',import.meta.url)),fixtureFile=path.resolve(process.argv[2]||'');
if(path.basename(fixtureFile)!=='session.json'||!path.dirname(fixtureFile).startsWith(path.join(project,'.local','ui-pilot-')))throw new Error('Only the owned synthetic UI fixture is supported');
const fixture=JSON.parse(fs.readFileSync(fixtureFile));if(fixture.origin!=='http://127.0.0.1:8790'||!fixture.source.startsWith(path.dirname(fixtureFile)+path.sep))throw new Error('Invalid UI fixture');
const executable=process.env.MOONRESTORE_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined);
const browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));const resultDir=path.join(project,'.local','ui-evidence');fs.mkdirSync(resultDir,{recursive:true});
const done=()=>page.waitForFunction(()=>!document.getElementById('refresh').disabled,{},{timeout:60000});
const result=async()=>JSON.parse(await page.locator('#result').innerText());
try{
  await page.goto(fixture.url);await page.locator('#connection').filter({hasText:'本机会话已连接'}).waitFor();assert.equal(new URL(page.url()).hash,'');
  await page.locator('#job-form [name=id]').fill('gui-papers');await page.locator('#job-form [name=source]').fill(fixture.source);await page.locator('#job-form [name=repository]').fill(fixture.repository);
  await page.getByRole('button',{name:'预检查容量',exact:true}).click();await done();assert.equal((await result()).kind,'capacity');assert.equal((await result()).ok,true);
  await page.getByRole('button',{name:'保存备份任务',exact:true}).click();await done();await page.locator('#jobs').filter({hasText:'gui-papers'}).waitFor();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'立即备份',exact:true}).click();await done();assert.equal((await result()).ok,true);assert.ok((await result()).drill);
  await page.getByRole('button',{name:'打开版本',exact:true}).click();await done();await page.locator('.snapshot').filter({hasText:'受控初稿'}).click();await done();
  await page.locator('#catalog').getByRole('button',{name:'paper.txt',exact:true}).click();
  await page.locator('#restore-form [name=target]').fill(fixture.restore);await page.getByRole('button',{name:'预览恢复范围',exact:true}).click();await done();assert.equal(await page.locator('#restore-confirm').isEnabled(),true);
  await page.locator('#restore-form [name=target]').fill(fixture.restore+'-changed');assert.equal(await page.locator('#restore-confirm').isDisabled(),true);
  await page.locator('#restore-form [name=target]').fill(fixture.restore);await page.getByRole('button',{name:'预览恢复范围',exact:true}).click();await done();
  await page.locator('#restore-confirm').click();await done();assert.equal(fs.readFileSync(path.join(fixture.restore,'paper.txt'),'utf8'),'Controlled first revision.');
  await page.getByRole('button',{name:'校验整个仓库',exact:true}).click();await done();assert.equal((await result()).ok,true);
  await page.getByRole('button',{name:'演练所选版本',exact:true}).click();await done();assert.equal((await result()).post_restore_readback,true);
  await page.getByRole('button',{name:'预览保留策略',exact:true}).click();await done();assert.equal((await result()).preview,true);
  await page.screenshot({path:path.join(resultDir,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:path.join(resultDir,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);const report={ok:true,actual_browser:'installed Chromium/Edge via Playwright',synthetic_fixture:true,real_user_pilot:false,checks:['capacity','save job','confirmed backup','versions','file selection','restore preview','stale preview disabled','actual historical restore','full audit','restore drill','retention preview','mobile no horizontal overflow','no page errors'],screenshot_files:['desktop.png','mobile.png']};
  fs.writeFileSync(path.join(resultDir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
