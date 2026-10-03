import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.FIELDINSPECT_AUTH || {};
let fallbackSupabase = null;
function getSupabase(){
  if(window.FIELDINSPECT_SUPABASE) return window.FIELDINSPECT_SUPABASE;
  if(!fallbackSupabase && cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY){
    fallbackSupabase=createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY);
  }
  return fallbackSupabase;
}

function historyKey(){
  const current=window.FIELDINSPECT_AUTH_USER||null;
  const key=current?.id||current?.email||'anonymous';
  return 'fieldinspect-pro-v2:history:'+key;
}

function readHistory(){
  if(typeof window.readHistory==='function') return window.readHistory();
  try{
    const value=JSON.parse(localStorage.getItem(historyKey())||'[]');
    return Array.isArray(value)?value:[];
  }catch(e){
    console.error('FieldInspect cloud history read failed:',e);
    return [];
  }
}

function writeHistory(list){
  if(typeof window.writeHistory==='function') return window.writeHistory(list);
  try{
    localStorage.setItem(historyKey(),JSON.stringify(list.slice(0,100)));
    return true;
  }catch(e){
    console.error('FieldInspect cloud history write failed:',e);
    return false;
  }
}

function user(){
  return window.FIELDINSPECT_AUTH_USER||null;
}

function cloudRow(record){
  const s=record.state||{},m=s.meta||{};
  return {
    user_id:user().id,
    local_id:record.id,
    title:record.projectName||m.projectName||'Untitled inspection',
    client_name:record.clientName||m.clientName||'',
    site_name:record.siteLocation||m.siteLocation||'',
    status:record.status||'draft',
    inspection_date:record.inspectionDate||m.inspectionDate||null,
    data:(typeof window.FIELDINSPECT_SERIALIZE_STATE==='function'?window.FIELDINSPECT_SERIALIZE_STATE(s):s),
    updated_at:record.updatedAt||new Date().toISOString()
  };
}

async function pull(){
  const supabase=getSupabase();
  if(!supabase||!user()) return;
  const {data,error}=await supabase.from('inspections')
    .select('id,local_id,title,client_name,site_name,status,inspection_date,data,created_at,updated_at')
    .eq('user_id',user().id)
    .order('updated_at',{ascending:false});
  if(error) throw error;

  const local=readHistory();
  const map=new Map(local.map(x=>[x.id,x]));

  for(const r of (data||[])){
    const s=r.data||{},existing=map.get(r.local_id);
    const remoteTime=Date.parse(r.updated_at||r.created_at||0)||0;
    const localTime=Date.parse(existing?.updatedAt||0)||0;
    if(!existing||remoteTime>localTime){
      map.set(r.local_id,{
        id:r.local_id,
        reportId:s?.meta?.reportId||r.local_id,
        projectName:r.title||s?.meta?.projectName||'Untitled inspection',
        clientName:r.client_name||s?.meta?.clientName||'',
        inspectorName:s?.meta?.inspectorName||'',
        siteLocation:r.site_name||s?.meta?.siteLocation||'',
        inspectionDate:r.inspection_date||s?.meta?.inspectionDate||'',
        overallStatus:s?.meta?.overallStatus||'Attention required',
        status:r.status||s?.meta?.workflowStatus||'draft',
        createdAt:r.created_at||new Date().toISOString(),
        updatedAt:r.updated_at||r.created_at||new Date().toISOString(),
        state:s
      });
    }
  }

  const merged=[...map.values()].sort((a,b)=>Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0));
  window.FIELDINSPECT_CLOUD_STATUS={state:'merged',at:new Date().toISOString(),count:merged.length};
  if(!writeHistory(merged)) throw new Error('Cloud history could not be written locally. Cloud records were not deleted.');
  if(typeof window.renderHistory==='function') window.renderHistory();
}

async function push(){
  const supabase=getSupabase();
  if(!supabase||!user()) return;
  const local=readHistory();
  if(!local.length) return;
  const rows=local.map(cloudRow);
  const {error}=await supabase.from('inspections').upsert(rows,{onConflict:'user_id,local_id'});
  if(error){
    window.FIELDINSPECT_CLOUD_STATUS={state:'error',at:new Date().toISOString(),message:error.message||'Cloud upload failed'};
    throw error;
  }
  window.FIELDINSPECT_CLOUD_STATUS={state:'pushed',at:new Date().toISOString(),count:rows.length};
}

async function deleteCloudRecord(localId){
  const supabase=getSupabase();
  if(!supabase||!user()||!localId) return;
  const {error}=await supabase.from('inspections')
    .delete()
    .eq('user_id',user().id)
    .eq('local_id',localId);
  if(error) throw error;
}

window.FIELDINSPECT_DELETE_CLOUD_INSPECTION=async function(localId){
  if(!user()) return;
  await deleteCloudRecord(localId);
};

let syncPromise=null;
async function sync(options={}){
  const supabase=getSupabase();
  if(!supabase||!user()) return {ok:false,reason:'not-authenticated'};
  if(syncPromise) return syncPromise;
  syncPromise=(async()=>{
    try{
      if(!options.skipPull) await pull();
      await push();
      await pull();
      window.FIELDINSPECT_CLOUD_STATUS={state:'synced',at:new Date().toISOString(),count:readHistory().length};
      return {ok:true};
    }catch(error){
      console.error('FieldInspect cloud sync failed:',error);
      window.FIELDINSPECT_CLOUD_STATUS={state:'error',at:new Date().toISOString(),message:error?.message||'Cloud sync failed'};
      return {ok:false,error};
    }finally{
      syncPromise=null;
    }
  })();
  return syncPromise;
}

window.FIELDINSPECT_SYNC_INSPECTIONS=sync;
window.FIELDINSPECT_CLOUD_STATUS={state:'idle',at:new Date().toISOString()};

async function boot(){
  if(typeof window.saveCurrentToHistory==='function'&&!window.__cloudSaveWrapped){
    const original=window.saveCurrentToHistory;
    window.saveCurrentToHistory=async function(){
      const saveResult=await original.apply(this,arguments);
      if(user()&&saveResult?.saved){
        sync().then(async result=>{
          if(result.ok){toast('Inspection saved and synced to cloud.');if(window.FIELDINSPECT_REFRESH_SUBSCRIPTION)await window.FIELDINSPECT_REFRESH_SUBSCRIPTION().catch(e=>console.error('FieldInspect subscription refresh failed:',e));}
          else toast('Inspection saved locally. Cloud sync will retry when available.');
        }).catch(error=>console.error('FieldInspect post-save cloud sync failed:',error));
      }
      return saveResult;
    };
    window.__cloudSaveWrapped=true;
  }

  if(typeof window.deleteHistoryRecord==='function'&&!window.__cloudDeleteWrapped){
    const originalDelete=window.deleteHistoryRecord;
    window.deleteHistoryRecord=function(id){
      const beforeRecords=readHistory();
      const before=beforeRecords.length;
      const removed=beforeRecords.find(x=>x.id===id);
      const result=originalDelete.apply(this,arguments);
      if(user()&&readHistory().length<before){
        deleteCloudRecord(id).then(async()=>{
          try{if(window.FIELDINSPECT_STORAGE?.deleteInspectionEvidence)await window.FIELDINSPECT_STORAGE.deleteInspectionEvidence(removed?.state?.meta?.storageId||removed?.reportId)}catch(e){console.error('FieldInspect cloud evidence delete failed:',e);toast('Inspection deleted, but some cloud evidence may remain.');}
          if(window.FIELDINSPECT_REFRESH_SUBSCRIPTION)await window.FIELDINSPECT_REFRESH_SUBSCRIPTION().catch(e=>console.error('FieldInspect subscription refresh failed:',e));
          toast('Inspection deleted and cloud history synced.');
        }).catch(error=>{
          console.error('FieldInspect cloud delete failed:',error);
          toast('Inspection deleted locally. Cloud delete will retry on the next sync.');
        });
      }
      return result;
    };
    window.__cloudDeleteWrapped=true;
  }

  await sync();
}

window.addEventListener('DOMContentLoaded',()=>setTimeout(boot,0));
window.addEventListener('fieldinspect:auth-changed',()=>setTimeout(boot,0));
window.addEventListener('online',()=>setTimeout(()=>sync(),500));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(()=>sync(),300)});
if(getSupabase()?.auth){
  getSupabase().auth.onAuthStateChange(()=>setTimeout(boot,0));
}
