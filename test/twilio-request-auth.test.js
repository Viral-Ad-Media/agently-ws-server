"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
function harness() {
 const module={exports:{}};
 const env={NODE_ENV:'production',API_URL:'https://api.example.test',TWILIO_WS_URL:'wss://calls.example.test',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),TWILIO_AUTH_TOKEN:'synthetic-token'};
 const db={from(){const q={select:()=>q,eq:()=>q,limit:async()=>({data:[],error:null})};return q;}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/twilio-request-auth.js'),'utf8'),{module,require:id=>id==='./supabase'?{getSupabase:()=>db}:require(id),process:{env},Buffer,URL,Set,Date});
 return {auth:module.exports,env};
}
test('provider callbacks reject missing signatures and tampered bodies/URLs',async()=>{
 const {auth,env}=harness(),req={method:'POST',originalUrl:'/api/twilio/call-status?x=1',headers:{},body:{AccountSid:env.TWILIO_ACCOUNT_SID,CallSid:'CA'+'2'.repeat(32)}};
 assert.equal(await auth.authenticateTwilio(req),null);
 req.headers['x-twilio-signature']=auth.signatureFor(env.TWILIO_AUTH_TOKEN,env.API_URL+req.originalUrl,req.body);
 assert.equal(await auth.authenticateTwilio(req),env.TWILIO_ACCOUNT_SID);
 req.body.CallSid='CA'+'3'.repeat(32);assert.equal(await auth.authenticateTwilio(req),null);
 req.body.CallSid='CA'+'2'.repeat(32);req.originalUrl+='&x=2';assert.equal(await auth.authenticateTwilio(req),null);
});
test('websocket verification uses configured origins and rejects spoofed host headers',async()=>{
 const {auth,env}=harness(),req={method:'GET',url:'/api/twilio/media-stream',headers:{host:'attacker.example','x-forwarded-host':'attacker.example'}};
 req.headers['x-twilio-signature']=auth.signatureFor(env.TWILIO_AUTH_TOKEN,env.TWILIO_WS_URL+req.url);
 assert.equal(await auth.authenticateTwilio(req,{websocket:true}),env.TWILIO_ACCOUNT_SID);
 req.headers['x-twilio-signature']=auth.signatureFor(env.TWILIO_AUTH_TOKEN,'https://attacker.example'+req.url);
 // A signature for the wrong host must not be accepted, even if correctly formed.
 assert.equal(await auth.authenticateTwilio(req,{websocket:true}),null);
});
