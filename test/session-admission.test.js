"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
test('call tokens require a live, matching account session and epoch',async()=>{
 const state={user:{organization_id:'org',session_epoch:0},row:{user_id:'user',organization_id:'org',created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),absolute_expires_at:new Date(Date.now()+3600000).toISOString()},error:null};
 const db={from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:table==='users'?state.user:state.row,error:state.error})};return q;}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/session-admission.js'),'utf8'),{module,require:()=>({getSupabase:()=>db}),Date,Number,Promise});
 const verify=module.exports.validateBoundSession,claims={sid:'sid',userId:'user',orgId:'org',sev:0};
 assert.equal(await verify(claims),true);
 state.row.revoked_at=new Date().toISOString();assert.equal(await verify(claims),false);state.row.revoked_at=null;
 state.user.session_epoch=1;assert.equal(await verify(claims),false);state.user.session_epoch=0;
 state.row.organization_id='other';assert.equal(await verify(claims),false);state.row.organization_id='org';
 state.row.last_seen_at=new Date(Date.now()-1800001).toISOString();assert.equal(await verify(claims),false);
 state.error={message:'outage'};await assert.rejects(verify(claims),/temporarily unavailable/);
});
