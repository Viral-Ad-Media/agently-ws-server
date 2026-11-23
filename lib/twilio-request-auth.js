"use strict";
const crypto=require('crypto');
const SID=/^AC[0-9a-f]{32}$/i;
let cached=null;
// Canonical URLs are configuration, never the untrusted Host/Forwarded headers.
function requestUrls(req,websocket=false) {
 const raw=String(req.originalUrl||req.url||'');
 if(!raw.startsWith('/')||raw.startsWith('//')||raw.includes('#')) return [];
 const bases=websocket?[process.env.TWILIO_WS_URL,process.env.API_URL]:[process.env.API_URL];
 if(!websocket && !bases[0]) bases[0]=require('./backend-url').getBackendBaseUrl();
 const urls=new Set();
 for(const base of bases.filter(Boolean)) {
  try {
   const origin=new URL(base);
   if(!['https:','wss:'].includes(origin.protocol) && process.env.NODE_ENV==='production') continue;
   origin.pathname='/';origin.search='';origin.hash='';
   const u=new URL(raw,origin);
   if(u.origin!==origin.origin) continue;
   urls.add(u.href);
   if(websocket) {
    u.protocol=u.protocol==='wss:'?'https:':u.protocol==='ws:'?'http:':u.protocol;
    urls.add(u.href);
    if(!u.pathname.endsWith('/')) {u.pathname+='/';urls.add(u.href);u.protocol=u.protocol==='https:'?'wss:':'ws:';urls.add(u.href);}
   }
  } catch {}
 }
 return [...urls];
}
function signatureFor(token,url,params={}) {
 let data=url;
 for(const key of Object.keys(params).sort()) {
  const values=Array.isArray(params[key])?[...new Set(params[key].map(String))].sort():[String(params[key]??'')];
  for(const value of values) data+=key+value;
 }
 return crypto.createHmac('sha1',token).update(data,'utf8').digest('base64');
}
function matches(signature,expected) {
 const a=Buffer.from(signature||''),b=Buffer.from(expected);
 return a.length===b.length && crypto.timingSafeEqual(a,b);
}
async function tenantTokens() {
 const cacheKey=String(process.env.TWILIO_ACCOUNT_SID||'');
 if(cached?.key===cacheKey && cached.until>Date.now()) return cached.rows;
 const {data,error}=await require('./supabase').getSupabase().from('twilio_accounts').select('account_sid,parent_account_sid,raw_response').eq('parent_account_sid',cacheKey).limit(201);
 if(error) throw error;
 if((data||[]).length>200) throw new Error('Twilio account validation capacity exceeded');
 const rows=(data||[]).filter(r=>SID.test(r.account_sid)&&r.raw_response?.auth_token).map(r=>({sid:r.account_sid,token:String(r.raw_response.auth_token)}));
 cached={key:cacheKey,until:Date.now()+60000,rows};
 return rows;
}
async function authenticateTwilio(req,{websocket=false}={}) {
 const signature=String(req.headers?.['x-twilio-signature']||'');
 if(!/^[A-Za-z0-9+/]{27}=$/.test(signature)) return null;
 const urls=requestUrls(req,websocket);
 if(!urls.length) return null;
 const params=String(req.method||'GET').toUpperCase()==='POST'&&!websocket?(req.body||{}):{};
 const declared=String(req.body?.AccountSid||req.query?.AccountSid||'');
 const masterSid=String(process.env.TWILIO_ACCOUNT_SID||'').trim();
 const token=String(process.env.TWILIO_AUTH_TOKEN||'').trim();
 const valid=(secret)=>secret && urls.some(url=>matches(signature,signatureFor(secret,url,params)));
 if((!declared||declared===masterSid)&&valid(token)) return masterSid;
 if(declared&&!SID.test(declared)) return null;
 const tokens=await tenantTokens();
 for(const account of tokens) if((!declared||declared===account.sid)&&valid(account.token)) return account.sid;
 return null;
}
async function requireTwilio(req,res,next) {
 try {
  const sid=await authenticateTwilio(req);
  res.locals.webhookSignatureOk=!!sid;
  if(!sid) return res.status(403).json({error:{code:'PROVIDER_SIGNATURE_INVALID',message:'Invalid provider signature.'}});
  req.twilioAccountSid=sid;next();
 } catch {
  res.setHeader('Retry-After','5');
  res.status(503).json({error:{code:'PROVIDER_VERIFICATION_UNAVAILABLE',message:'Provider verification temporarily unavailable.'}});
 }
}
module.exports={authenticateTwilio,requireTwilio,signatureFor,requestUrls};

