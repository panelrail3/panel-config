const http=require('http');
const fs=require('fs'); const path=require('path'); const net=require('net');
const crypto=require('crypto'); const bcrypt=require('bcryptjs'); const QRCode=require('qrcode'); const Database=require('better-sqlite3');
const {execFile,spawn}=require('child_process');
const {v4:uuidv4}=require('uuid');
const DATA=process.env.DATA_DIR||'/app/data'; const RUNTIME='/app/runtime';
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(RUNTIME,{recursive:true});
const db=new Database(path.join(DATA,'panel.db')); db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inbounds(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,listen TEXT,port INTEGER,path TEXT,network TEXT,security TEXT,config TEXT,enabled INTEGER DEFAULT 1,created_at INTEGER); CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,email TEXT,protocol TEXT,uuid TEXT,password TEXT,flow TEXT,expiry INTEGER,limit_gb REAL,enabled INTEGER DEFAULT 1,created_at INTEGER); CREATE TABLE IF NOT EXISTS client_inbounds(client_id TEXT,inbound_id TEXT,PRIMARY KEY(client_id,inbound_id));`);
const getSetting=db.prepare('SELECT value FROM settings WHERE key=?'); const setSetting=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
if(!getSetting.get('admin_user')) setSetting.run('admin_user','admin');
if(!getSetting.get('admin_hash')) setSetting.run('admin_hash',bcrypt.hashSync('admin',12));
if(!getSetting.get('session_secret')) setSetting.run('session_secret',crypto.randomBytes(32).toString('hex'));
const sessions=new Map(); let xrayProc=null; let xrayLogs=[]; let startedAt=null;
const PORT_PANEL=Number(process.env.PANEL_PORT||1323), PORT_GATEWAY=Number(process.env.PORT||1400);
function json(res,obj,status=200){const b=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(b)});res.end(b)}
function body(req){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>5e6) req.destroy()});req.on('end',()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}});req.on('error',reject)})}
function token(){return crypto.randomBytes(32).toString('hex')}
function auth(req){const c=req.headers.cookie||''; const m=c.match(/sid=([^;]+)/); return m&&sessions.has(m[1])?sessions.get(m[1]):null}
function requireAuth(req,res){if(!auth(req)){json(res,{error:'unauthorized'},401);return false}return true}
function publicHost(req){return process.env.PUBLIC_HOST||process.env.RAILWAY_PUBLIC_DOMAIN||req.headers.host?.split(':')[0]||'YOUR_DOMAIN'}
function parseCfg(x){try{return x?JSON.parse(x):{}}catch{return {}}}
function nextXrayPort(){const rows=db.prepare('SELECT port FROM inbounds').all(); const used=new Set(rows.map(r=>r.port));let p=20000;while(used.has(p))p++;return p}
function inboundConfig(i,clients){
 const network=i.network||'ws';
 const stream={network};
 if(network==='ws') stream.wsSettings={path:i.path||'/api/ws',headers:{}};
 if(network==='httpupgrade') stream.httpupgradeSettings={path:i.path||'/api/ws',host:''};
 if(network==='grpc') stream.grpcSettings={serviceName:(i.path||'xray').replace(/^\//,'')};
 if(network==='tcp') stream.tcpSettings={acceptProxy:false,header:{type:'none'}};
 // HTTP transports behind Railway Gateway terminate public TLS at the Railway edge.
 // Xray therefore receives plaintext HTTP/WebSocket internally.
 if(network==='ws' || network==='httpupgrade' || network==='grpc') {
   stream.security='none';
 } else if(i.security==='reality') {
   stream.security='reality';
   const adv=parseCfg(i.config);
   const r=adv.realitySettings||{};
   stream.realitySettings={
     show:false,
     dest:r.dest||'example.com:443',
     xver:Number(r.xver||0),
     serverNames:Array.isArray(r.serverNames)&&r.serverNames.length?r.serverNames:['example.com'],
     privateKey:r.privateKey||'REPLACE_WITH_REALITY_PRIVATE_KEY',
     shortIds:Array.isArray(r.shortIds)?r.shortIds:['']
   };
 } else {
   stream.security='none';
 }
 let mapped=[];
 if(i.protocol==='vless') mapped=clients.map(c=>({id:c.uuid,flow:c.flow||'',email:c.email||''}));
 else if(i.protocol==='vmess') mapped=clients.map(c=>({id:c.uuid,alterId:0,email:c.email||''}));
 else if(i.protocol==='trojan') mapped=clients.map(c=>({password:c.password||c.uuid,email:c.email||'',flow:c.flow||''}));
 else if(i.protocol==='shadowsocks') mapped=clients.map(c=>({password:c.password||c.uuid,email:c.email||'',method:'aes-128-gcm'}));
 const settings=i.protocol==='shadowsocks'?{clients:mapped}:({clients:mapped,decryption:'none',fallbacks:[]});
 return {listen:i.listen||'127.0.0.1',port:i.port,protocol:i.protocol,settings,streamSettings:stream,tag:`in-${i.id}`};
}
function buildConfig(){
 const ins=db.prepare('SELECT * FROM inbounds WHERE enabled=1 ORDER BY created_at').all(); const clients=db.prepare('SELECT * FROM clients WHERE enabled=1').all();
 const out=[]; for(const i of ins){const cs=db.prepare('SELECT c.* FROM clients c JOIN client_inbounds ci ON ci.client_id=c.id WHERE ci.inbound_id=? AND c.enabled=1').all(i.id); out.push(inboundConfig(i,cs))}
 return {log:{loglevel:'warning',access:'/app/runtime/access.log',error:'/app/runtime/error.log'},inbounds:out,outbounds:[{protocol:'freedom',tag:'direct'},{protocol:'blackhole',tag:'blocked'}],routing:{domainStrategy:'AsIs',rules:[]}};
}
function writeConfig(){const cfg=buildConfig();const file=path.join(RUNTIME,'config.json');fs.writeFileSync(file,JSON.stringify(cfg,null,2));return {cfg,file}}
function xrayTest(cb){writeConfig();execFile(process.env.XRAY_BIN||'/opt/xray/xray',['run','-test','-config',path.join(RUNTIME,'config.json')],{timeout:15000},(err,stdout,stderr)=>cb(!err,stdout||'',stderr||''))}
function stopXray(){if(xrayProc){xrayProc.kill('SIGTERM');xrayProc=null}startedAt=null}
function startXray(cb){if(xrayProc){return cb(true,'already running')} xrayTest((ok,out,err)=>{if(!ok)return cb(false,err||out);const bin=process.env.XRAY_BIN||'/opt/xray/xray';xrayProc=spawn(bin,['run','-config',path.join(RUNTIME,'config.json')],{stdio:['ignore','pipe','pipe']});startedAt=Date.now();xrayProc.stdout.on('data',d=>pushLog(d.toString()));xrayProc.stderr.on('data',d=>pushLog(d.toString()));xrayProc.on('exit',(code)=>{pushLog(`xray exited: ${code}`);xrayProc=null;startedAt=null});cb(true,'started')})}
function restartXray(cb){stopXray();setTimeout(()=>startXray(cb),100)}
function pushLog(s){for(const l of s.split(/\r?\n/)){if(l.trim())xrayLogs.push(new Date().toISOString()+' '+l);};if(xrayLogs.length>500)xrayLogs=xrayLogs.slice(-500)}
function linksFor(i,c){
 const host=publicHost({headers:{host:''}});
 const publicPort=443;
 const network=i.network||'ws';
 // Railway terminates TLS before the Gateway. Never advertise h2 for WebSocket.
 const path=i.path||'/api/ws';
 const tls=(network==='ws'||network==='httpupgrade'||network==='grpc')?'tls':(i.security==='reality'?'reality':'none');
 let link='';
 if(c.protocol==='vless') {
   const q=new URLSearchParams();
   q.set('type',network); q.set('security',tls); q.set('encryption','none');
   if(network==='ws'||network==='httpupgrade') q.set('path',path);
   if(network==='grpc') q.set('serviceName',path.replace(/^\//,''));
   if(tls==='tls') q.set('sni',host);
   link=`vless://${c.uuid}@${host}:${publicPort}?${q.toString()}#${encodeURIComponent(c.email||'VLESS')}`;
 } else if(c.protocol==='vmess') {
   const obj={v:'2',ps:c.email||'VMess',add:host,port:String(publicPort),id:c.uuid,aid:'0',scy:'auto',net:network,type:'none',host:host,path:network==='grpc'?'':path,tls:tls==='tls'?'tls':''};
   if(network==='grpc') obj.path='';
   link='vmess://'+Buffer.from(JSON.stringify(obj)).toString('base64url');
 } else if(c.protocol==='trojan') {
   const q=new URLSearchParams(); q.set('type',network); q.set('security',tls); q.set('sni',host);
   if(network==='ws'||network==='httpupgrade') q.set('path',path);
   if(network==='grpc') q.set('serviceName',path.replace(/^\//,''));
   link=`trojan://${encodeURIComponent(c.password||c.uuid)}@${host}:${publicPort}?${q.toString()}#${encodeURIComponent(c.email||'Trojan')}`;
 } else if(c.protocol==='shadowsocks') {
   const u=Buffer.from(`aes-128-gcm:${c.password||c.uuid}`).toString('base64url');
   link=`ss://${u}@${host}:${publicPort}#${encodeURIComponent(c.email||'SS')}`;
 }
 return link;
}
function clientLinks(c){return db.prepare('SELECT i.* FROM inbounds i JOIN client_inbounds ci ON ci.inbound_id=i.id WHERE ci.client_id=? AND i.enabled=1').all(c.id).map(i=>({inbound:i,link:linksFor(i,c)}));}
async function api(req,res){const u=new URL(req.url,'http://localhost');const p=u.pathname;
 if(p==='/api/health')return json(res,{ok:true,version:'7.0.0',xray:!!xrayProc});
 if(p==='/api/login'&&req.method==='POST'){const b=await body(req);const user=getSetting.get('admin_user').value,hash=getSetting.get('admin_hash').value;if(b.username!==user||!bcrypt.compareSync(b.password||'',hash))return json(res,{error:'invalid credentials'},401);const t=token();sessions.set(t,{user});res.setHeader('Set-Cookie',`sid=${t}; HttpOnly; SameSite=Lax; Path=/`);return json(res,{ok:true})}
 if(p==='/api/logout'){const c=req.headers.cookie||'';const m=c.match(/sid=([^;]+)/);if(m)sessions.delete(m[1]);res.setHeader('Set-Cookie','sid=; Max-Age=0; Path=/');return json(res,{ok:true})}
 if(!requireAuth(req,res))return;
 if(p==='/api/me')return json(res,{user:auth(req).user});
 if(p==='/api/status')return json(res,{xray:{running:!!xrayProc,startedAt,version:process.env.XRAY_VERSION||'26.9.8'},counts:{inbounds:db.prepare('SELECT count(*) n FROM inbounds').get().n,clients:db.prepare('SELECT count(*) n FROM clients').get().n},host:publicHost(req),ports:{panel:PORT_PANEL,gateway:PORT_GATEWAY},logs:xrayLogs.slice(-100)});
 if(p==='/api/inbounds'&&req.method==='GET')return json(res,db.prepare('SELECT * FROM inbounds ORDER BY created_at DESC').all().map(x=>({...x,config:parseCfg(x.config)})));
 if(p==='/api/inbounds'&&req.method==='POST'){const b=await body(req);const id=uuidv4(),port=Number(b.port||nextXrayPort());if(db.prepare('SELECT id FROM inbounds WHERE port=?').get(port))return json(res,{error:'internal port already used'},409);const rec={id,name:b.name||'VLESS WebSocket',protocol:b.protocol||'vless',listen:'127.0.0.1',port,path:b.path||'/api/ws',network:b.network||'ws',security:b.security||'none',config:JSON.stringify(b.advanced||{}),enabled:b.enabled===false?0:1,created_at:Date.now()};db.prepare('INSERT INTO inbounds(id,name,protocol,listen,port,path,network,security,config,enabled,created_at) VALUES(@id,@name,@protocol,@listen,@port,@path,@network,@security,@config,@enabled,@created_at)').run(rec);return restartXray(()=>json(res,{ok:true,id}))}
 const im=p.match(/^\/api\/inbounds\/([^/]+)$/); if(im){const id=im[1];if(req.method==='DELETE'){db.prepare('DELETE FROM client_inbounds WHERE inbound_id=?').run(id);db.prepare('DELETE FROM inbounds WHERE id=?').run(id);return restartXray(()=>json(res,{ok:true}))}if(req.method==='PUT'){const b=await body(req);const old=db.prepare('SELECT * FROM inbounds WHERE id=?').get(id);if(!old)return json(res,{error:'not found'},404);const rec={...old,...b,id,config:JSON.stringify(b.advanced||parseCfg(old.config)),enabled:b.enabled===false?0:1};db.prepare('UPDATE inbounds SET name=@name,protocol=@protocol,path=@path,network=@network,security=@security,config=@config,enabled=@enabled WHERE id=@id').run(rec);return restartXray(()=>json(res,{ok:true}))}}
 if(p==='/api/clients'&&req.method==='GET'){const rows=db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();return json(res,rows.map(c=>({...c,inbounds:clientLinks(c).map(x=>x.inbound.id),links:clientLinks(c).map(x=>x.link)})))}
 if(p==='/api/clients'&&req.method==='POST'){const b=await body(req);const id=uuidv4();const proto=b.protocol||'vless';const rec={id,email:b.email||`client-${id.slice(0,6)}`,protocol:proto,uuid:b.uuid||uuidv4(),password:b.password||crypto.randomBytes(12).toString('base64url'),flow:b.flow||'',expiry:Number(b.expiry||0),limit_gb:Number(b.limit_gb||0),enabled:b.enabled===false?0:1,created_at:Date.now()};db.prepare('INSERT INTO clients(id,email,protocol,uuid,password,flow,expiry,limit_gb,enabled,created_at) VALUES(@id,@email,@protocol,@uuid,@password,@flow,@expiry,@limit_gb,@enabled,@created_at)').run(rec);for(const iid of (b.inbounds||[]))db.prepare('INSERT OR IGNORE INTO client_inbounds(client_id,inbound_id) VALUES(?,?)').run(id,iid);return restartXray(()=>json(res,{ok:true,id,client:rec,links:clientLinks(rec)}))}
 const cm=p.match(/^\/api\/clients\/([^/]+)$/);if(cm){const id=cm[1];if(req.method==='DELETE'){db.prepare('DELETE FROM client_inbounds WHERE client_id=?').run(id);db.prepare('DELETE FROM clients WHERE id=?').run(id);return restartXray(()=>json(res,{ok:true}))}if(req.method==='PUT'){const b=await body(req);const old=db.prepare('SELECT * FROM clients WHERE id=?').get(id);if(!old)return json(res,{error:'not found'},404);const rec={...old,...b,id};db.prepare('UPDATE clients SET email=@email,protocol=@protocol,uuid=@uuid,password=@password,flow=@flow,expiry=@expiry,limit_gb=@limit_gb,enabled=@enabled WHERE id=@id').run(rec);db.prepare('DELETE FROM client_inbounds WHERE client_id=?').run(id);for(const iid of (b.inbounds||[]))db.prepare('INSERT OR IGNORE INTO client_inbounds(client_id,inbound_id) VALUES(?,?)').run(id,iid);return restartXray(()=>json(res,{ok:true}))}}
 if(p==='/api/xray/test'&&req.method==='POST')return xrayTest((ok,out,err)=>json(res,{ok,stdout:out,stderr:err},ok?200:422));
 if(p==='/api/xray/start'&&req.method==='POST')return startXray((ok,msg)=>json(res,{ok,message:msg},ok?200:500));
 if(p==='/api/xray/stop'&&req.method==='POST'){stopXray();return json(res,{ok:true})}
 if(p==='/api/xray/restart'&&req.method==='POST')return restartXray((ok,msg)=>json(res,{ok,message:msg},ok?200:500));
 if(p==='/api/xray/config')return json(res,buildConfig());
 if(p==='/api/subscribe'&&req.method==='GET'){const cid=u.searchParams.get('client');const c=db.prepare('SELECT * FROM clients WHERE id=?').get(cid);if(!c)return json(res,{error:'not found'},404);const links=clientLinks(c).map(x=>x.link);return json(res,{links,base64:Buffer.from(links.join('\n')).toString('base64')})}
 if(p==='/api/qr'&&req.method==='GET'){const cid=u.searchParams.get('client');const c=db.prepare('SELECT * FROM clients WHERE id=?').get(cid);if(!c)return json(res,{error:'not found'},404);const l=clientLinks(c)[0]?.link;if(!l)return json(res,{error:'client has no inbound'},400);return json(res,{data:l,qr:await QRCode.toDataURL(l,{margin:1,width:360})})}
 if(p==='/api/settings/password'&&req.method==='POST'){const b=await body(req);if(!b.password||b.password.length<8)return json(res,{error:'password must be at least 8 characters'},400);setSetting.run('admin_hash',bcrypt.hashSync(b.password,12));return json(res,{ok:true})}
 if(p==='/api/backup'&&req.method==='GET'){return json(res,{version:1,inbounds:db.prepare('SELECT * FROM inbounds').all(),clients:db.prepare('SELECT * FROM clients').all(),links:db.prepare('SELECT * FROM client_inbounds').all()})}
 if(p==='/api/backup'&&req.method==='POST'){const b=await body(req);const tx=db.transaction(()=>{db.exec('DELETE FROM client_inbounds;DELETE FROM clients;DELETE FROM inbounds;');for(const i of (b.inbounds||[]))db.prepare('INSERT INTO inbounds VALUES(@id,@name,@protocol,@listen,@port,@path,@network,@security,@config,@enabled,@created_at)').run(i);for(const c of (b.clients||[]))db.prepare('INSERT INTO clients VALUES(@id,@email,@protocol,@uuid,@password,@flow,@expiry,@limit_gb,@enabled,@created_at)').run(c);for(const x of (b.links||[]))db.prepare('INSERT INTO client_inbounds VALUES(@client_id,@inbound_id)').run(x)});try{tx();return restartXray(()=>json(res,{ok:true}))}catch(e){return json(res,{error:e.message},400)}}
 return json(res,{error:'not found'},404);
}
const panel=http.createServer(async(req,res)=>{if(req.url.startsWith('/api/')){try{await api(req,res)}catch(e){json(res,{error:e.message},500)}return}if(req.url.startsWith('/static/'))return res.end('');res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(fs.readFileSync('/app/public/index.html'))});
panel.listen(PORT_PANEL,'0.0.0.0',()=>console.log(`Panel listening on ${PORT_PANEL}`));
const gateway=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 // Normal HTTP requests to /api/* belong to the panel. WebSocket upgrades are handled below.
 if(pathname.startsWith('/api/') || pathname==='/' || pathname.startsWith('/panel')) return proxyToPanel(req,res);
 const i=targetForPath(pathname);
 if(i) return proxyHttp(req,res,i);
 res.writeHead(404,{'content-type':'text/plain'});res.end('Not found');
});
function targetForPath(p){
 const rows=db.prepare("SELECT * FROM inbounds WHERE enabled=1 AND network IN ('ws','httpupgrade') ORDER BY length(path) DESC").all();
 return rows.find(i=>p===i.path || p.startsWith(i.path.endsWith('/')?i.path:i.path+'/'));
}
function proxyToPanel(req,res){
 const h={...req.headers,host:`127.0.0.1:${PORT_PANEL}`};
 const pr=http.request({host:'127.0.0.1',port:PORT_PANEL,path:req.url,method:req.method,headers:h},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});
 pr.on('error',()=>{if(!res.headersSent){res.writeHead(502)}res.end('Panel unavailable')});
 req.pipe(pr);
}
function proxyHttp(req,res,i){
 const pr=http.request({host:'127.0.0.1',port:i.port,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${i.port}`}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});
 pr.on('error',()=>{if(!res.headersSent){res.writeHead(502)}res.end('Xray unavailable')});
 req.pipe(pr);
}
// Correct WebSocket reverse proxy: preserve the original HTTP/1.1 Upgrade request,
// wait for the upstream Xray handshake, then bridge both raw TCP streams.
gateway.on('upgrade',(req,socket,head)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 const i=targetForPath(pathname);
 if(!i){socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');socket.destroy();return;}
 const c=net.connect({host:'127.0.0.1',port:i.port},()=>{
   const lines=[`${req.method} ${req.url} HTTP/1.1`];
   for(const [k,v] of Object.entries(req.headers)){
     if(v===undefined || k.toLowerCase()==='connection') continue;
     lines.push(`${k}: ${v}`);
   }
   lines.push('Connection: Upgrade','Upgrade: websocket','','');
   c.write(lines.join('\r\n'));
   if(head && head.length)c.write(head);
 });
 const close=()=>{if(!socket.destroyed)socket.destroy();if(!c.destroyed)c.destroy();};
 c.on('error',close); socket.on('error',close); c.on('close',()=>{if(!socket.destroyed)socket.destroy()}); socket.on('close',()=>{if(!c.destroyed)c.destroy()});
 // Do not pipe until upstream has produced its handshake; otherwise an upstream
 // connection failure can leave the client waiting forever.
 let upstreamHeader=Buffer.alloc(0), bridged=false;
 const onData=chunk=>{
   if(bridged){socket.write(chunk);return;}
   upstreamHeader=Buffer.concat([upstreamHeader,chunk]);
   const marker=upstreamHeader.indexOf(Buffer.from('\r\n\r\n'));
   if(marker===-1){if(upstreamHeader.length>65536)close();return;}
   const headerEnd=marker+4;
   socket.write(upstreamHeader.subarray(0,headerEnd));
   const rest=upstreamHeader.subarray(headerEnd);
   if(rest.length)socket.write(rest);
   bridged=true;
   c.removeListener('data',onData);
   c.on('data',d=>{if(!socket.destroyed)socket.write(d)});
   socket.pipe(c);
 };
 c.on('data',onData);
});
gateway.listen(PORT_GATEWAY,'0.0.0.0',()=>console.log(`Gateway listening on ${PORT_GATEWAY}`));
setTimeout(()=>startXray((ok,msg)=>console.log('Xray autostart',ok,msg)),1500);
