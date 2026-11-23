"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createActionLedger}=require("../lib/owner-action-ledger");
test("voice click and spoken approval cannot execute the same action twice",async()=>{
 let count=0,finish;const events=[];
 const ledger=createActionLedger({emit:e=>events.push(e.state),execute:async()=>{count++;await new Promise(r=>finish=r);return {success:true};}});
 const entry=ledger.stage("book",{slot:"one"});assert.equal(count,0);
 const pending=ledger.decide(entry.id,"approve");await ledger.decide(entry.id,"approve");finish();await pending;await ledger.decide(entry.id,"approve");
 assert.equal(count,1);assert.deepEqual(events,["pending","processing","completed"]);
});
test("cancelled and expired reviews never execute",async()=>{
 let now=0,count=0;const ledger=createActionLedger({emit:()=>{},execute:async()=>{count++;},now:()=>now});
 const cancelled=ledger.stage("book",{slot:1});await ledger.decide(cancelled.id,"cancel");await ledger.decide(cancelled.id,"approve");
 const expired=ledger.stage("book",{slot:2});now=600001;await ledger.decide(expired.id,"approve");assert.equal(count,0);
});
