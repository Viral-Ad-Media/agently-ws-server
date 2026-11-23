"use strict";
const crypto=require("crypto");
function createActionLedger({emit,execute,now=Date.now}) {
  const entries=new Map();
  const keys=new Map();
  function stage(name,args,preview={}) {
    const key=JSON.stringify([name,Object.keys(args).sort().map(k=>[k,args[k]])]);
    const existing=entries.get(keys.get(key));
    if(existing && !["cancelled","expired"].includes(existing.state)) return existing;
    const entry={id:crypto.randomUUID(),name,args:JSON.parse(JSON.stringify(args)),preview,state:"pending",expiresAt:now()+600000};
    entries.set(entry.id,entry);keys.set(key,entry.id);emit({...entry,type:"owner.action"});return entry;
  }
  async function decide(id,decision) {
    const entry=entries.get(id);
    if(!entry) return {success:false,message:"That review is no longer available on this call."};
    if(entry.state!=="pending") return entry.result || {success:false,message:`This action is ${entry.state}.`};
    if(now()>entry.expiresAt) {entry.state="expired";emit({...entry,type:"owner.action"});return {success:false,message:"This review expired. Prepare it again."};}
    if(decision==="cancel") {entry.state="cancelled";entry.result={success:false,message:"Cancelled before execution."};emit({...entry,type:"owner.action"});return entry.result;}
    if(decision!=="approve")return {success:false,message:"Unknown decision."};
    entry.state="processing";emit({...entry,type:"owner.action"});
    try {entry.result=await execute(entry.name,entry.args);}catch(error){entry.result={success:false,message:error.message || "Could not verify the outcome. Check the records before trying again."};}
    entry.state=entry.result.partial ? "partial" : entry.result.success ? "completed" : "failed";
    emit({...entry,type:"owner.action"});return entry.result;
  }
  return {stage,decide};
}
module.exports={createActionLedger};
