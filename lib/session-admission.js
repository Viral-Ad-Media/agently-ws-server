"use strict";
// Used only after cryptographic verification of a purpose-scoped call token.
async function validateBoundSession(claims) {
 if(!claims?.sid||!claims.userId||!claims.orgId||!Number.isInteger(claims.sev)) return false;
 const db=require('./supabase').getSupabase();
 const [{data:session,error:sessionError},{data:user,error:userError}]=await Promise.all([
  db.from('auth_sessions').select('user_id,organization_id,created_at,last_seen_at,absolute_expires_at,revoked_at').eq('id',claims.sid).maybeSingle(),
  db.from('users').select('organization_id,session_epoch').eq('id',claims.userId).maybeSingle(),
 ]);
 if(sessionError||userError) throw new Error('Session verification temporarily unavailable');
 if(!session||!user||session.revoked_at||session.user_id!==claims.userId||session.organization_id!==claims.orgId||user.organization_id!==claims.orgId||Number(user.session_epoch||0)!==claims.sev) return false;
 const now=Date.now(),created=Date.parse(session.created_at),last=Date.parse(session.last_seen_at),expires=Date.parse(session.absolute_expires_at);
 return [created,last,expires].every(Number.isFinite)&&created<=now&&last<=now+60000&&now<expires&&now-created<28800000&&now-last<1800000;
}
module.exports={validateBoundSession};
