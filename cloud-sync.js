import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const cfg = window.FIELDINSPECT_AUTH || {};
let fallbackSupabase = null;
let syncPromise = null;

function getSupabase(){
  if(window.FIELDINSPECT_SUPABASE) return window.FIELDINSPECT_SUPABASE;
  if(!fallbackSupabase && cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY){
    fallbackSupabase=createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY);
  }
  return fallbackSupabase;
}
function user(){return window.FIELDINSPECT_AUTH_USER||null;}
function historyKey(){
  const u=user();
  return 'fieldinspect-pro-v2:history:'+(u?.id||u?.email||'anonymous');
}
function trashKey(){
  const u=user();
  return 'fieldinspect-pro-v2:trash:'+(u?.id||u?.email||'anonymous');
}
function readHistory(){
  if(typeof window.readHistory==='function')return window.readHistory();
  try{
    const v=JSON.parse(localStorage.getItem(historyKey())||'[]');
    return Array.isArray(v)?v:[];
  }catch(e){return[]}
}
function writeHistory(list){
  if(typeof window.writeHistory==='function')return window.writeHistory(list);
  try{localStorage.setItem(historyKey(),JSON.stringify(Array.isArray(list)?list.slice(0,100):[]));return true}
  catch(e){console.error('FieldInspect history write failed:',e);return false}
}
function readTrash(){
  if(typeof window.readTrash==='function')return window.readTrash();
  try{
    const v=JSON.parse(localStorage.getItem(trashKey())||'[]');
    return Array.isArray(v)?v:[];
  }catch(e){return[]}
}
function setCloudStatus(state,message='',count=null){
  const payload={state,at:new Date().toISOString(),message:message||'',count};
  window.FIELDINSPECT_CLOUD_STATUS=payload;
  const el=document.getElementById('cloudSyncText');
  if(!el)return;
  const labels={
    idle:'Cloud ready',
    syncing:'Syncing…',
    synced:'Cloud synced',
    merged:'Cloud merged',
    partial:'Cloud partly synced',
    error:'Cloud sync error',
    offline:'Offline',
    signedout:'Sign in to sync'
  };
  el.textContent=labels[state]||state;
  el.title=message||labels[state]||state;
  el.className='text-[10px] font-bold '+(
    state==='synced'?'text-emerald-600':
    state==='error'?'text-rose-600':
    state==='offline'?'text-amber-600':
    state==='signedout'?'text-slate-400':
    'text-indigo-600'
  );
}
function normalizeStatus(value){
  return ['draft','in-progress','completed','archived'].includes(value)?value:'draft';
}
function serializeState(state){
  return typeof window.FIELDINSPECT_SERIALIZE_STATE==='function'
    ? window.FIELDINSPECT_SERIALIZE_STATE(state)
    : JSON.parse(JSON.stringify(state||{}));
}
function buildRemoteState(record){
  const s=record?.data&&typeof record.data==='object'?structuredClone(record.data):{};
  s.meta=s.meta||{};
  s.meta.reportId=s.meta.reportId||record.local_id||record.id;
  s.meta.storageId=s.meta.storageId||s.meta.reportId;
  s.meta.workflowStatus=normalizeStatus(record.status||s.meta.workflowStatus);
  s.items=Array.isArray(s.items)?s.items.map(item=>({
    ...item,
    photos:Array.isArray(item.photos)?item.photos.map(photo=>({
      ...photo,
      id:photo.id||('PHOTO-'+crypto.randomUUID())
    })):[]
  })):[];
  s.attachments=Array.isArray(s.attachments)?s.attachments.map(a=>({
    ...a,
    id:a.id||('DOC-'+crypto.randomUUID())
  })):[];
  return s;
}
function cloudRow(record){
  const s=record.state||{},m=s.meta||{};
  return {
    user_id:user().id,
    local_id:record.id,
    title:record.projectName||m.projectName||'Untitled inspection',
    client_name:record.clientName||m.clientName||'',
    site_name:record.siteLocation||m.siteLocation||'',
    status:normalizeStatus(record.status||m.workflowStatus),
    inspection_date:record.inspectionDate||m.inspectionDate||null,
    data:serializeState(s),
    updated_at:record.updatedAt||new Date().toISOString()
  };
}
async function pull(){
  const supabase=getSupabase(),u=user();
  if(!supabase||!u)return {count:0};
  const {data,error}=await supabase.from('inspections')
    .select('id,local_id,title,client_name,site_name,status,inspection_date,data,created_at,updated_at')
    .eq('user_id',u.id)
    .order('updated_at',{ascending:false});
  if(error)throw error;

  const local=readHistory();
  const trashed=new Set(readTrash().map(x=>x?.id).filter(Boolean));
  const map=new Map(local.filter(x=>!trashed.has(x.id)).map(x=>[x.id,x]));

  for(const remote of (data||[])){
    if(!remote.local_id||trashed.has(remote.local_id))continue;
    const existing=map.get(remote.local_id);
    const remoteTime=Date.parse(remote.updated_at||remote.created_at||0)||0;
    const localTime=Date.parse(existing?.updatedAt||0)||0;
    if(!existing||remoteTime>localTime){
      const s=buildRemoteState(remote);
      map.set(remote.local_id,{
        id:remote.local_id,
        reportId:s.meta.reportId,
        projectName:remote.title||s.meta.projectName||'Untitled inspection',
        clientName:remote.client_name||s.meta.clientName||'',
        inspectorName:s.meta.inspectorName||'',
        siteLocation:remote.site_name||s.meta.siteLocation||'',
        inspectionDate:remote.inspection_date||s.meta.inspectionDate||'',
        overallStatus:s.meta.overallStatus||'Attention required',
        status:normalizeStatus(remote.status||s.meta.workflowStatus),
        createdAt:remote.created_at||new Date().toISOString(),
        updatedAt:remote.updated_at||remote.created_at||new Date().toISOString(),
        state:s
      });
    }
  }

  const merged=[...map.values()].sort((a,b)=>Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0));
  if(!writeHistory(merged))throw new Error('Cloud history could not be written locally. Remote data was not deleted.');
  if(typeof window.renderHistory==='function')window.renderHistory();
  setCloudStatus('merged','Remote history merged.',merged.length);
  return {count:merged.length};
}
function normalizeSubscriptionRow(data){
  return Array.isArray(data)?(data[0]||null):(data||null);
}
function isInspectionLimitError(error){
  const text=[error?.message,error?.details,error?.hint,error?.code].filter(Boolean).join(' ').toUpperCase();
  return text.includes('INSPECTION_LIMIT_REACHED')||text.includes('INSPECTION LIMIT')||text.includes('LIMIT_REACHED');
}
function isSubscriptionInactiveError(error){
  const text=[error?.message,error?.details,error?.hint,error?.code].filter(Boolean).join(' ').toUpperCase();
  return text.includes('SUBSCRIPTION_INACTIVE')||text.includes('SUBSCRIPTION INACTIVE');
}
function subscriptionMessage(row){
  if(!row)return 'Cloud subscription could not be verified.';
  const status=String(row.status||'').toUpperCase();
  const used=Number(row.inspections_used||0);
  const limit=row.inspection_limit==null?null:Number(row.inspection_limit);
  if(status!=='TRIAL'&&status!=='ACTIVE')return 'Your subscription is inactive.';
  if(limit!=null&&used>=limit)return 'Your inspection limit has been reached. New inspections remain saved locally until your plan is upgraded or renewed.';
  return '';
}
async function ensureCloudSubscription(){
  const supabase=getSupabase(),u=user();
  if(!supabase||!u)return null;
  if(!supabase.rpc)throw new Error('Supabase subscription service is unavailable.');
  const {data,error}=await supabase.rpc('ensure_trial_subscription');
  if(error)throw error;
  const row=normalizeSubscriptionRow(data);
  if(!row?.user_id || row.user_id!==u.id){
    throw new Error('Cloud subscription could not be verified for the signed-in user.');
  }
  return row;
}
async function push(subscription=null){
  const supabase=getSupabase(),u=user();
  if(!supabase||!u)return {count:0,failed:[],limitReached:false,inactive:false};
  const trashed=new Set(readTrash().map(x=>x?.id).filter(Boolean));
  const local=readHistory().filter(x=>x?.id&&!trashed.has(x.id));
  const failed=[];
  let pushed=0;
  let limitReached=false;
  let inactive=false;

  for(const record of local){
    try{
      const s=record.state||{};
      const m=s.meta||{};
      const remoteStatus=normalizeStatus(record.status||m.workflowStatus);
      const {data,error}=await supabase.rpc('sync_inspection',{
        p_local_id:String(record.id),
        p_title:record.projectName||m.projectName||'Untitled inspection',
        p_client_name:record.clientName||m.clientName||'',
        p_site_name:record.siteLocation||m.siteLocation||'',
        p_status:remoteStatus,
        p_inspection_date:record.inspectionDate||m.inspectionDate||null,
        p_data:serializeState(s),
        p_created_at:record.createdAt||null,
        p_updated_at:record.updatedAt||new Date().toISOString()
      });
      if(error)throw error;
      if(!data?.id)throw new Error('Cloud inspection write was not acknowledged by Supabase.');
      pushed++;
    }catch(error){
      const message=error?.message||'Cloud upload failed';
      const limited=isInspectionLimitError(error);
      const subInactive=isSubscriptionInactiveError(error);
      const subMissing=String(error?.message||'').toUpperCase().includes('SUBSCRIPTION_NOT_FOUND');
      limitReached=limitReached||limited;
      inactive=inactive||subInactive||subMissing;
      failed.push({
        id:record.id,
        message:limited
          ? 'New inspection blocked by the subscription inspection limit.'
          : subInactive
            ? 'New inspection blocked because the subscription is inactive.'
            : subMissing
              ? 'No cloud subscription exists for this account.'
              : message,
        code:error?.code||'',
        reason:limited?'inspection-limit':(subInactive||subMissing?'subscription-inactive':'upload-failed')
      });
      console.error('FieldInspect cloud record push failed:',record.id,error);
    }
  }

  return {count:pushed,failed,limitReached,inactive};
}
async function deleteCloudRecord(localId){
  const supabase=getSupabase(),u=user();
  if(!supabase||!u||!localId)return;
  const {data:existing,error:lookupError}=await supabase.from('inspections')
    .select('id')
    .eq('user_id',u.id)
    .eq('local_id',localId)
    .maybeSingle();
  if(lookupError)throw lookupError;
  if(!existing?.id)return false;

  const {data,error}=await supabase.from('inspections')
    .delete()
    .eq('user_id',u.id)
    .eq('local_id',localId)
    .select('id');
  if(error)throw error;
  if(!data?.length)throw new Error('Cloud inspection deletion was not acknowledged by Supabase.');
  return true;
}
async function deleteCloudRecords(records){
  const list=Array.isArray(records)?records.filter(r=>r?.id):[];
  const failed=[];
  for(const record of list){
    try{
      await deleteCloudRecord(record.id);
      if(window.FIELDINSPECT_STORAGE?.deleteInspectionEvidence&&record?.state?.meta?.storageId){
        await window.FIELDINSPECT_STORAGE.deleteInspectionEvidence(record.state.meta.storageId);
      }
    }catch(error){
      failed.push({id:record?.id,message:error?.message||'Cloud deletion failed'});
      console.error('FieldInspect cloud permanent deletion failed:',record?.id,error);
    }
  }
  return {ok:failed.length===0,failed};
}
async function sync(options={}){
  const supabase=getSupabase();
  if(!supabase){
    setCloudStatus('error','Supabase client is not configured.');
    return {ok:false,reason:'not-configured'};
  }
  if(!navigator.onLine){
    setCloudStatus('offline','No internet connection. Local inspections are safe and will sync automatically.');
    return {ok:false,reason:'offline'};
  }

  // Re-read the current session at sync time. This avoids a startup race where
  // the auth module has not yet populated FIELDINSPECT_AUTH_USER.
  if(!user()&&supabase.auth){
    try{
      const {data}=await supabase.auth.getSession();
      if(data?.session?.user){
        window.FIELDINSPECT_AUTH_USER=data.session.user;
      }
    }catch(error){
      console.error('FieldInspect session refresh failed:',error);
    }
  }

  const u=user();
  if(!u){
    setCloudStatus('signedout','Sign in to synchronize inspections.');
    return {ok:false,reason:'not-authenticated'};
  }
  if(syncPromise)return syncPromise;

  syncPromise=(async()=>{
    setCloudStatus('syncing','Synchronizing inspections…');
    try{
      const pulled=await pull();

      let subscription=null;
      let subscriptionError=null;
      try{
        subscription=await ensureCloudSubscription();
      }catch(error){
        subscriptionError=error;
        console.error('FieldInspect subscription check failed:',error);
      }

      // Always process permanent deletions before uploads. A record in the
      // local trash must never be recreated in the cloud.
      const deleted=await deleteCloudRecords(readTrash());
      const pushed=await push(subscription);
      const finalPull=await pull();

      const totalFailures=deleted.failed.length+pushed.failed.length;
      const limitReached=Boolean(pushed.limitReached);
      const inactive=Boolean(pushed.inactive);
      const hasSubscriptionError=Boolean(subscriptionError);

      let state='synced';
      let detail='Local and cloud inspection history are synchronized.';

      if(limitReached){
        state='partial';
        detail='Cloud sync completed for existing inspections, but one or more new inspections are waiting for available plan capacity.';
      }else if(inactive){
        state='partial';
        detail='Cloud sync completed for existing inspections, but new inspections are waiting for an active subscription.';
      }else if(hasSubscriptionError){
        state='partial';
        detail='Cloud data was merged, but subscription status could not be verified.';
      }else if(totalFailures){
        state='partial';
        detail=totalFailures+' cloud operation(s) still need retry.';
      }

      const ok=state==='synced'&&totalFailures===0&&!hasSubscriptionError;
      setCloudStatus(state,detail,finalPull.count);
      return {
        ok,
        reason:ok?'synced':'partial',
        pulled,
        subscription,
        subscriptionError,
        deleted,
        pushed,
        finalPull
      };
    }catch(error){
      console.error('FieldInspect cloud sync failed:',error);
      setCloudStatus('error',error?.message||'Cloud synchronization failed.');
      return {ok:false,error};
    }finally{
      syncPromise=null;
    }
  })();
  return syncPromise;
}

window.FIELDINSPECT_SYNC_INSPECTIONS=sync;
window.FIELDINSPECT_DELETE_CLOUD_INSPECTION=deleteCloudRecord;
window.FIELDINSPECT_PURGE_CLOUD_DELETED=deleteCloudRecords;
window.FIELDINSPECT_SYNC_NOW=async function(){
  const result=await sync({manual:true});
  if(result.ok)toast('Cloud sync completed.');
  else if(result.reason==='offline')toast('You are offline. Local inspections are safe and will sync automatically when you reconnect.');
  else if(result.reason==='not-authenticated')toast('Sign in to synchronize your inspections.');
  else if(result.pushed?.limitReached)toast('Cloud sync completed for existing inspections. Your new inspection is saved locally because your inspection limit has been reached.');
  else if(result.pushed?.inactive)toast('Cloud sync completed for existing inspections. Your new inspection is saved locally because your subscription is inactive.');
  else if(result.subscriptionError)toast('Cloud data was merged, but subscription status could not be verified. Your local inspections are preserved.');
  else toast('Cloud sync needs attention. Your local inspections are preserved.');
  return result;
};
window.FIELDINSPECT_CLOUD_STATUS={state:'idle',at:new Date().toISOString()};

async function boot(){
  if(typeof window.saveCurrentToHistory==='function'&&!window.__cloudSaveWrapped){
    const original=window.saveCurrentToHistory;
    window.saveCurrentToHistory=async function(){
      const saveResult=await original.apply(this,arguments);
      if(user()&&saveResult?.saved){
        const result=await sync();
        if(!result.ok)toast('Inspection saved locally. Cloud sync will retry automatically.');
      }
      return saveResult;
    };
    window.__cloudSaveWrapped=true;
  }

  if(typeof window.deleteHistoryRecord==='function'&&!window.__cloudDeleteWrapped){
    const originalDelete=window.deleteHistoryRecord;
    window.deleteHistoryRecord=function(id){
      const before=readHistory();
      const result=originalDelete.apply(this,arguments);
      if(user()&&readHistory().length<before.length){
        sync().catch(error=>console.error('FieldInspect delete sync failed:',error));
      }
      return result;
    };
    window.__cloudDeleteWrapped=true;
  }

  await sync();
}

window.addEventListener('DOMContentLoaded',()=>setTimeout(boot,150));
window.addEventListener('fieldinspect:auth-changed',()=>setTimeout(boot,100));
window.addEventListener('online',()=>setTimeout(()=>sync(),500));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(()=>sync(),300)});
if(getSupabase()?.auth){
  getSupabase().auth.onAuthStateChange(()=>setTimeout(boot,100));
}
