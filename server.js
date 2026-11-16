
const express = require('express');
const ftp = require('basic-ftp');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Local app account: password hash is stored under Electron's per-user data folder.
const authDir = process.env.DANTE_STORAGE_USER_DATA || path.join(os.homedir(), '.dante-ps5-storage-manager');
const authFile = path.join(authDir, 'login.json');
const sessions = new Map();
const loginAttempts = new Map();
function readAuthConfig() {
  try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); }
  catch (_) { return null; }
}
function parseCookies(header='') {
  return Object.fromEntries(header.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))]}));
}
function currentSession(req) {
  const sid=parseCookies(req.headers.cookie||'').dante_session;
  return sid ? sessions.get(sid) : null;
}
function setSession(res) {
  const sid=crypto.randomBytes(32).toString('hex');
  sessions.set(sid,{created:Date.now()});
  res.setHeader('Set-Cookie','dante_session='+sid+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
}
function clearSession(req,res) {
  const sid=parseCookies(req.headers.cookie||'').dante_session;
  if(sid) sessions.delete(sid);
  res.setHeader('Set-Cookie','dante_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
function authRequired(req,res,next) {
  const session=currentSession(req);
  if(!session) return res.status(401).json({error:'Please log in to use Dante’s PS5 Storage Manager.'});
  next();
}

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), 'ps5sm-uploads') });
app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(__dirname, 'public')));
let client = null;
let connectedHost = null;
// Keep FTP commands in sequence: many console FTP servers do not handle
// overlapping LIST/NOOP/transfer commands reliably.
let ftpQueue = Promise.resolve();
function withFtp(task) {
  const run = ftpQueue.then(async () => {
    if (!client || client.closed) throw new Error('FTP is not connected.');
    return task(client);
  });
  ftpQueue = run.catch(() => {});
  return run;
}

// FTPSRV is more reliable when the client changes into a directory first,
// then issues LIST with no path argument. This also avoids servers that
// return the root listing for LIST /some/folder.
async function listDirectory(c, dir) {
  const target = (typeof dir === 'string' && dir.trim()) ? dir.trim() : '/';
  await c.cd(target);
  const entries = await c.list();
  let actual = target;
  try { actual = await c.pwd(); } catch (_) {}
  return { entries, path: actual || target };
}

app.get('/api/auth/status',(req,res)=>{
  const cfg=readAuthConfig();
  res.json({setupRequired:!cfg,authenticated:!!currentSession(req),username:cfg?.username||null});
});
app.post('/api/auth/setup',async(req,res)=>{
  if(readAuthConfig()) return res.status(409).json({error:'An account already exists. Please log in.'});
  const username=String(req.body?.username||'').trim();
  const password=String(req.body?.password||'');
  if(!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({error:'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.'});
  if(password.length<10 || password.length>128) return res.status(400).json({error:'Password must be at least 10 characters (maximum 128).'});
  try {
    fs.mkdirSync(authDir,{recursive:true});
    const salt=crypto.randomBytes(16).toString('hex');
    const hash=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(e,b)=>e?reject(e):resolve(b.toString('hex'))));
    fs.writeFileSync(authFile,JSON.stringify({username,salt,hash,createdAt:new Date().toISOString()},null,2),{mode:0o600,flag:'wx'});
    setSession(res); res.json({ok:true,username});
  } catch(e) { res.status(500).json({error:'Could not create the local account: '+e.message}); }
});
app.post('/api/auth/login',async(req,res)=>{
  const ip=req.ip||'local'; const now=Date.now(); const attempt=loginAttempts.get(ip)||{count:0,until:0};
  if(attempt.until>now) return res.status(429).json({error:'Too many attempts. Wait 30 seconds and try again.'});
  const cfg=readAuthConfig();
  if(!cfg) return res.status(409).json({error:'Create your local account first.'});
  const username=String(req.body?.username||'').trim(); const password=String(req.body?.password||'');
  const supplied=await new Promise((resolve,reject)=>crypto.scrypt(password,cfg.salt,64,(e,b)=>e?reject(e):resolve(b.toString('hex'))));
  const a=Buffer.from(supplied,'hex'), b=Buffer.from(cfg.hash,'hex');
  const valid=username===cfg.username && a.length===b.length && crypto.timingSafeEqual(a,b);
  if(!valid){attempt.count++; if(attempt.count>=5){attempt.count=0;attempt.until=now+30000;} loginAttempts.set(ip,attempt); return res.status(401).json({error:'Incorrect username or password.'});}
  loginAttempts.delete(ip); setSession(res); res.json({ok:true,username:cfg.username});
});
app.post('/api/auth/logout',(req,res)=>{clearSession(req,res);res.json({ok:true});});
app.use('/api',authRequired);

app.post('/api/connect', async (req,res) => {
  const {host,port=2121,user='anonymous',password=''} = req.body || {};
  if (!host) return res.status(400).json({error:'Enter your PS5 IP address.'});
  try {
    if (client) { try { client.close(); } catch {} }
    client = new ftp.Client(15000);
    await client.access({host,port:Number(port),user,password,secure:false});
    connectedHost = host;
    res.json({ok:true,host});
  } catch(e) {
    client=null; connectedHost=null;
    res.status(502).json({error:e.message || 'FTP connection failed.'});
  }
});
app.get('/api/status',async(req,res)=>{
  if(!client || client.closed){
    connectedHost=null;
    return res.json({connected:false,host:null});
  }
  try {
    // Do not send NOOP here: some console FTP servers reject it.
    // Report the local session state and let the next real operation test it.
    return res.json({connected:true,host:connectedHost});
  } catch(e) {
    try { client.close(); } catch {}
    client=null; connectedHost=null;
    return res.json({connected:false,host:null,error:e.message || 'FTP session lost'});
  }
});

app.post('/api/disconnect',(req,res)=>{
  if(client){try{client.close();}catch{}}
  client=null; connectedHost=null; res.json({ok:true});
});
app.get('/api/list',async(req,res)=>{
  if(!client) return res.status(400).json({error:'Connect to PS5 FTP first.'});
  const dir=typeof req.query.path==='string'?req.query.path:'/';
  try {
    const result=await withFtp(c => listDirectory(c, dir));
    res.json({path:result.path,entries:result.entries.map(x=>({name:x.name,type:x.isDirectory?'directory':'file',size:x.size}))});
  } catch(e){res.status(502).json({error:e.message});}
});
app.post('/api/upload',upload.single('file'),async(req,res)=>{
  if(!client) return res.status(400).json({error:'FTP is not connected.'});
  if(!req.file) return res.status(400).json({error:'Choose a file.'});
  const dir=typeof req.body.remoteDir==='string' && req.body.remoteDir.trim() ? req.body.remoteDir.trim() : '/';
  if(!dir.startsWith('/') || dir.includes('\\') || dir.split('/').some(part=>part==='..')) {
    if(fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({error:'Invalid destination folder path.'});
  }
  const fileName=path.basename(req.file.originalname);
  if(!fileName || fileName==='.' || fileName==='..') {
    if(fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({error:'Invalid file name.'});
  }
  const verify=req.file.path+'.verify';
  try {
    const source=fs.readFileSync(req.file.path);
    const sourceHash=crypto.createHash('sha256').update(source).digest('hex');
    // Change into the selected folder first; FTPSRV handles CWD + STOR more
    // consistently than an absolute destination path.
    await withFtp(async c => { await c.cd(dir); const existing=await c.list(); if(existing.some(item=>item.name===fileName)) throw new Error('A file with that name already exists in this folder. Rename your upload or delete the existing file first.'); await c.uploadFrom(req.file.path,fileName); await c.downloadTo(verify,fileName); });
    const copy=fs.readFileSync(verify);
    const copyHash=crypto.createHash('sha256').update(copy).digest('hex');
    if(source.length!==copy.length || sourceHash!==copyHash)
      return res.status(502).json({verified:false,error:'Read-back verification failed. Do not rely on this copy.'});
    res.json({ok:true,verified:true,size:source.length,sha256:sourceHash,message:'Upload verified: size and SHA-256 match.'});
  } catch(e){res.status(502).json({verified:false,error:e.message});}
  finally {
    if(fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if(fs.existsSync(verify)) fs.unlinkSync(verify);
  }
});
// Delete one explicitly selected remote file. Directories are never removed by this endpoint.
app.post('/api/delete',async(req,res)=>{
  if(!client) return res.status(400).json({error:'FTP is not connected.'});
  const {remotePath}=req.body||{};
  if(typeof remotePath!=='string' || !remotePath.startsWith('/') || remotePath.includes('\\') || remotePath.split('/').some(part=>part==='..'))
    return res.status(400).json({error:'Invalid remote file path.'});
  const name=remotePath.split('/').filter(Boolean).pop();
  if(!name || name==='.' || name==='..' || remotePath.endsWith('/'))
    return res.status(400).json({error:'Select a file, not a folder.'});
  try {
    const parent=remotePath.slice(0,remotePath.lastIndexOf('/')) || '/';
    const result=await withFtp(c => listDirectory(c, parent));
    const entry=result.entries.find(x=>x.name===name);
    if(!entry) return res.status(404).json({error:'File not found. Refresh the folder and try again.'});
    if(entry.isDirectory) return res.status(400).json({error:'Folder deletion is disabled. Select an individual file.'});
    await withFtp(async c => { await c.cd(parent); await c.remove(name); });
    res.json({ok:true,message:'File deleted: '+name});
  } catch(e){res.status(502).json({error:e.message || 'FTP delete failed.'});}
});
// Delete a selected folder and everything inside it.
app.post('/api/delete-folder', async (req, res) => {
if (!client) {
return res.status(400).json({ error: 'FTP is not connected.' });
}

const { remotePath } = req.body || {};

if (
typeof remotePath !== 'string' ||
!remotePath.startsWith('/') ||
remotePath.includes('\\') ||
remotePath.endsWith('/') ||
remotePath.split('/').some(part => part === '..')
) {
return res.status(400).json({ error: 'Invalid folder path.' });
}

const parts = remotePath.split('/').filter(Boolean);

if (
parts.length === 0 ||
(parts.length === 1 && parts[0] === 'mnt') ||
(parts.length === 2 &&
parts[0] === 'mnt' &&
['usb0', 'usb1'].includes(parts[1]))
) {
return res.status(400).json({
error: 'This folder is protected.'
});
}

const name = parts.pop();
const parent = '/' + parts.join('/');

try {
await withFtp(async c => {
const listing = await listDirectory(c, parent);
const entry = listing.entries.find(x => x.name === name);

if (!entry) {
throw new Error('Folder not found. Refresh and try again.');
}

if (!entry.isDirectory) {
throw new Error('The selected item is not a folder.');
}

await c.removeDir(name);
});

res.json({
ok: true,
message: 'Folder deleted: ' + name
});
} catch (e) {
res.status(502).json({ error: e.message });
}
});

app.post('/api/download',async(req,res)=>{
  if(!client) return res.status(400).json({error:'FTP is not connected.'});
  const {remotePath,name}=req.body||{};
  if(!remotePath || !name || name.includes('/') || name.includes('\\'))
    return res.status(400).json({error:'Invalid download request.'});
  const first=path.join(os.tmpdir(),'ps5sm-'+Date.now()+'-'+name);
  const second=first+'.verify';
  try {
    await withFtp(async c => { await c.downloadTo(first,remotePath); await c.downloadTo(second,remotePath); });
    const a=crypto.createHash('sha256').update(fs.readFileSync(first)).digest('hex');
    const b=crypto.createHash('sha256').update(fs.readFileSync(second)).digest('hex');
    if(a!==b) throw new Error('Read-back verification failed. Retry the download.');
    res.setHeader('X-Transfer-Verified','true');
    res.setHeader('X-Transfer-SHA256',a);
    res.download(first,name,()=>{if(fs.existsSync(first))fs.unlinkSync(first);});
  } catch(e){res.status(502).json({error:e.message});}
  finally {if(fs.existsSync(second))fs.unlinkSync(second);}
});
// Bind only to this PC. Port 0 asks Windows for a free local port, avoiding
// conflicts with another copy of the manager or another app using 8787.
const port=Number(process.env.PORT||0);
const server=app.listen(port,'127.0.0.1',()=>console.log('Storage Manager at http://127.0.0.1:'+server.address().port));
module.exports=server;
