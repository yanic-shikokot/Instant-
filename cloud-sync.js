import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.FIELDINSPECT_AUTH || {};
const supabase = window.FIELDINSPECT_SUPABASE || (
  cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY
    ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY)
    : null
);

const HISTORY_KEY = 'fieldinspect-pro-v2:history';

function readHistory(){
  try{
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  }catch(e){ return []; }
}

function writeHistory(list){
  localStorage.setItem(HISTORY_KEY,JSON.stringify(list.slice(0,100)));
}

function user(){
  return window.FIELDINSPECT_AUTH_USER || null;
}

function cloudRow(record){
  const s = record.state || {};
  const m = s.meta || {};
  return {
    user_id:user().id,
    local_id:record.id,
    title:record.projectName || m.projectName || 'Untitled inspection',
    client_name:record.clientName || m.clientName || '',
    site_name:record.siteLocation || m.siteLocation || '',
    status:'completed',
    inspection_date:record.inspectionDate || m.inspectionDate || null,
    data:s,
    updated_at:record.updatedAt || new Date().toISOString()
  };
}

async function pull(){
  if(!supabase || !user()) return;
  const {data,error}=await supabase.from('inspections')
    .select('id,local_id,title,client_name,site_name,status,inspection_date,data,created_at,updated_at')
    .eq('user_id',user().id)
    .order('updated_at',{ascending:false});
  if(error) throw error;

  const local=readHistory();
  const map=new Map(local.map(x=>[x.id,x]));

  for(const r of (data||[])){
    const s=r.data||{};
    const existing=map.get(r.local_id);
    const remoteTime=Date.parse(r.updated_at||r.created_at||0)||0;
    const localTime=Date.parse(existing?.updatedAt||0)||0;
    if(!existing || remoteTime>localTime){
      map.set(r.local_id,{
        id:r.local_id,
        reportId:s?.meta?.reportId||r.local_id,
        projectName:r.title||s?.meta?.projectName||'Untitled inspection',
        clientName:r.client_name||s?.meta?.clientName||'',
        inspectorName:s?.meta?.inspectorName||'',
        siteLocation:r.site_name||s?.meta?.siteLocation||'',
        inspectionDate:r.inspection_date||s?.meta?.inspectionDate||'',
        overallStatus:s?.meta?.overallStatus||'Attention required',
        updatedAt:r.updated_at||r.created_at||new Date().toISOString(),
        state:s
      });
    }
  }

  writeHistory([...map.values()].sort((a,b)=>
    Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0)
  ));
  if(typeof window.renderHistory==='function') window.renderHistory();
}

async function push(){
  if(!supabase || !user()) return;
  const rows=readHistory().map(cloudRow);
  if(!rows.length) return;
  const {error}=await supabase.from('inspections').upsert(rows,{onConflict:'user_id,local_id'});
  if(error) throw error;
}

async function sync(){
  if(!supabase || !user()) return {ok:false};
  try{
    await pull();
    await push();
    await pull();
    return {ok:true};
  }catch(error){
    console.error('FieldInspect cloud sync failed:',error);
    return {ok:false,error};
  }
}

window.FIELDINSPECT_SYNC_INSPECTIONS=sync;

async function boot(){
  if(typeof window.saveCurrentToHistory==='function' && !window.__cloudSaveWrapped){
    const original=window.saveCurrentToHistory;
    window.saveCurrentToHistory=async function(){
      original.apply(this,arguments);
      if(user()){
        const result=await sync();
        if(result.ok) toast('Inspection saved and synced to cloud.');
      }
    };
    window.__cloudSaveWrapped=true;
  }
  await sync();
}

window.addEventListener('DOMContentLoaded',()=>setTimeout(boot,0));
window.addEventListener('fieldinspect:auth-changed',()=>setTimeout(boot,0));
