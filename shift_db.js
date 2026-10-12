/* ============================================================
   shift_db.js — サクラシフト：Supabase とのやりとり（内勤・キャスト共通）
   ------------------------------------------------------------
   今までの GAS と同じ「action 名・返事の形」のまま、中身だけ Supabase にした。
   画面側は StaffGas._get / _post などから ShiftDB.call(params) を呼ぶだけ。

   ・内勤：ポータルのログイン（naikin@…・20時間）をそのまま使う
   ・キャスト：キャスト用のログイン（このタブだけ・24時間）
   ・だれが何をできるかは Supabase 側の鍵（RLS）で決まる。ここで決めているわけではない。
   ※ sakurashift-staff と sakurashift-cast に同じファイルを置く（中身は同じにする）
   ============================================================ */
(function(){
  const SUPABASE_URL = "https://tuxqpqokbvkrckgxcfdn.supabase.co";
  const SUPABASE_KEY = "sb_publishable_PyvCZHSzYlaqauYbdZybng_zbftghak";
  const STAFF_EMAIL = 'naikin@sakuramoong.internal';
  const STAFF_HOURS = 20, CAST_HOURS = 24;
  const CAST_DOMAIN = '@cast.sakuramoong.internal';

  // 内勤のページか、キャストのページか（キャストのページは読み込む前に window.SHIFT_DB_ROLE='cast' にする）
  const ROLE = (window.SHIFT_DB_ROLE === 'cast') ? 'cast' : 'staff';

  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, ROLE === 'cast'
    ? { auth: { storage: window.sessionStorage, storageKey: 'sakura-cast-auth',
                persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
    : { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

  /* ---------- ログインの確かめ ---------- */
  function jwtPayload(s){
    try{
      const p = s.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    }catch(e){ return {}; }
  }
  // パスワードでログインした時刻（トークンを更新しても変わらない）
  function loginAtSec(s){
    const amr = jwtPayload(s).amr || [];
    let t = 0;
    amr.forEach(a=>{ if(a && Number(a.timestamp) > t) t = Number(a.timestamp); });
    return t;
  }
  function sessionExpiresAt(s){
    const t = loginAtSec(s);
    return t ? (t + (ROLE === 'cast' ? CAST_HOURS : STAFF_HOURS) * 3600) * 1000 : 0;
  }
  function sessionCast(s){
    const am = (s && s.user && s.user.app_metadata) || {};
    return am.role === 'shift_cast' ? String(am.cast || '') : '';
  }
  function isValid(s){
    if(!s || !s.user) return false;
    if(Date.now() >= sessionExpiresAt(s)) return false;
    if(ROLE === 'cast') return !!sessionCast(s);
    return String(s.user.email || '').toLowerCase() === STAFF_EMAIL;
  }
  async function getSession(){
    try{
      const { data } = await sb.auth.getSession();
      return isValid(data && data.session) ? data.session : null;
    }catch(e){ return null; }
  }

  async function sha256(str){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  // キャストの名前 → ログイン用のアドレス（日本語の名前はアドレスに使えないので、名前から作った記号にする）
  async function castEmail(name){ return 'c' + (await sha256(String(name).trim())).slice(0, 24) + CAST_DOMAIN; }

  /* ---------- 共通 ---------- */
  const AUTH_CODES = ['42501','PGRST301','PGRST302','PGRST303'];
  function isAuthErr(e){
    if(!e) return false;
    return AUTH_CODES.indexOf(String(e.code||'')) >= 0 || e.status === 401 || e.status === 403;
  }
  function q(res){ if(res.error) throw res.error; return res.data; }
  const cut = (v, n)=> String(v == null ? '' : v).slice(0, n);
  const parse = (v, d)=>{ if(v == null || v === '') return d; if(typeof v !== 'string') return v; try{ return JSON.parse(v); }catch(e){ return undefined; } };
  const list = (v)=> String(v || '').split(',').filter(Boolean);

  // 1000件ずつ全部読む
  async function selectAll(build){
    const out = [];
    for(let from = 0; ; from += 1000){
      const rows = q(await build().range(from, from + 999));
      out.push.apply(out, rows || []);
      if(!rows || rows.length < 1000) break;
    }
    return out;
  }
  function byCast(rows){
    const w = {};
    rows.forEach(r=>{ (w[r.cast_name] = w[r.cast_name] || {})[r.wk] = r.data; });
    return w;
  }
  const masterTable = ()=> ROLE === 'cast' ? 'shift_master_public' : 'shift_master';
  async function loadMaster(){
    const r = q(await sb.from(masterTable()).select('data').eq('id', 1).maybeSingle());
    return (r && r.data) || {};
  }
  async function loadRecruit(){
    const r = q(await sb.from('shift_recruit').select('data').eq('id', 1).maybeSingle());
    return (r && r.data) || null;
  }
  async function loadNotes(weeks){
    const notes = {};
    if(!weeks.length) return notes;
    q(await sb.from('shift_staff_notes').select('wk,data').in('wk', weeks)).forEach(r=>{ notes[r.wk] = r.data; });
    return notes;
  }
  async function loadNotifications(role, castName){
    let b = sb.from('shift_notifications').select('id,type,message,created_at,read').eq('role', role);
    if(role === 'cast') b = b.eq('cast_name', castName);
    const rows = q(await b.order('created_at', { ascending: true }).limit(2000));
    return rows.map(r=>({ id: r.id, type: r.type, message: r.message, createdAt: r.created_at, read: !!r.read }));
  }
  function logRow(x, by){
    return { type: cut(x.type, 40), cast_name: cut(x.cast, 60), week: cut(x.week, 400),
             detail: cut(x.detail, 2000), by_name: cut(x.by || by, 60) };
  }
  function myName(){
    return sessionStorage.getItem(ROLE === 'cast' ? 'castName' : 'staffName') || '';
  }

  /* ---------- action ごとの中身（返事の形は GAS と同じ） ---------- */
  const A = {
    async verifySession(){ const s = await getSession(); return { valid: !!s, name: myName(), role: ROLE }; },

    async loadStaffNames(){
      const m = await loadMaster();
      return { staffList: (m.staffList || []).map(x=>({ name: x.name, color: x.color || '' })) };
    },

    async loadMaster(){ return { master: await loadMaster() }; },

    async bootstrap(p, s){
      const weeks = list(p.weeks);
      if(ROLE === 'staff'){
        const since = p.sinceWk || '';
        const [master, rows, notes, notifications, recruitInfo] = await Promise.all([
          loadMaster(),
          selectAll(()=>{
            let b = sb.from('shift_weeks').select('cast_name,wk,data');
            if(since && weeks.length) b = b.or('wk.gte.' + since + ',wk.in.(' + weeks.join(',') + ')');
            else if(since) b = b.gte('wk', since);
            return b.order('cast_name').order('wk');
          }),
          loadNotes(weeks),
          loadNotifications('staff', ''),
          loadRecruit(),
        ]);
        return { master, weeks: byCast(rows), notes, notifications, recruitInfo };
      }
      const me = sessionCast(s);
      const [master, rows, notifications, recruitInfo, myEmail] = await Promise.all([
        loadMaster(),
        weeks.length ? q(await sb.from('shift_weeks').select('wk,data').eq('cast_name', me).in('wk', weeks)) : [],
        loadNotifications('cast', me),
        loadRecruit(),
        sb.rpc('shift_my_email').then(r=>q(r) || ''),
      ]);
      const my = {}; rows.forEach(r=>{ my[r.wk] = r.data; });
      return { master, weeks: my, myEmail, notifications, recruitInfo };
    },

    async loadMonth(p, s){
      const cast = p.cast || '';
      if(ROLE === 'cast' && cast !== sessionCast(s)) return { error: 'FORBIDDEN' };
      const weeks = list(p.weeks);
      const out = {};
      if(weeks.length){
        q(await sb.from('shift_weeks').select('wk,data').eq('cast_name', cast).in('wk', weeks)).forEach(r=>{ out[r.wk] = r.data; });
      }
      return { cast, weeks: out };
    },

    async loadWeek(p, s){
      const cast = p.cast || '';
      if(ROLE === 'cast' && cast !== sessionCast(s)) return { error: 'FORBIDDEN' };
      const r = q(await sb.from('shift_weeks').select('data').eq('cast_name', cast).eq('wk', p.wk || '').maybeSingle());
      return { cast, wk: p.wk || '', data: r ? r.data : null };
    },

    async loadAllWeeks(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      const since = p.sinceWk || '';
      const rows = await selectAll(()=>{
        let b = sb.from('shift_weeks').select('cast_name,wk,data');
        if(since) b = b.gte('wk', since);
        return b.order('cast_name').order('wk');
      });
      return { weeks: byCast(rows) };
    },

    async loadAllMonth(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      const weeks = list(p.weeks);
      if(!weeks.length) return { weeks: {} };
      const rows = await selectAll(()=>sb.from('shift_weeks').select('cast_name,wk,data').in('wk', weeks).order('cast_name').order('wk'));
      return { weeks: byCast(rows) };
    },

    async saveWeek(p){
      if(!p.cast || !p.wk || !p.data) return { error: 'MISSING_PARAMS' };
      const data = parse(p.data);
      if(!data || typeof data !== 'object') return { error: 'INVALID_DATA' };
      return q(await sb.rpc('shift_save_week', {
        p_cast: p.cast, p_wk: p.wk, p_data: data,
        p_base: p.baseUpdatedAt || '', p_force: p.force === true || p.force === 'true',
      }));
    },

    // 複数週をまとめて保存：保存できた週と、競合した週（あとで画面がマージして保存し直す）を返す
    async saveWeeks(p, s){
      const cast = p.cast || '';
      if(ROLE === 'cast' && cast !== sessionCast(s)) return { error: 'FORBIDDEN' };
      const items = parse(p.data, []);
      if(!cast || !Array.isArray(items)) return { error: 'INVALID_DATA' };
      const savedWks = [], conflicts = [];
      const results = await Promise.all(items.map(it=>sb.rpc('shift_save_week', {
        p_cast: cast, p_wk: it.wk, p_data: it.data, p_base: it.baseUpdatedAt || '', p_force: false,
      }).then(q)));
      for(let i = 0; i < results.length; i++){
        const r = results[i] || {};
        if(r.success) savedWks.push(items[i].wk);
        else if(r.conflict) conflicts.push({ wk: items[i].wk, serverData: r.serverData, serverUpdatedAt: r.serverUpdatedAt });
        else return { error: r.error || 'SAVE_FAILED' };
      }
      return { success: true, savedWks, conflicts };
    },

    // シフト提出のあと：内勤へのお知らせ・メール・記録をまとめて
    async submitDone(p, s){
      const cast = ROLE === 'cast' ? sessionCast(s) : (p.cast || '');
      await Promise.all([
        sb.from('shift_notifications').insert({
          id: 'n' + Date.now() + Math.floor(Math.random() * 1000),
          role: 'staff', cast_name: cut(cast, 60), type: 'submit', message: cut(p.message, 4000),
        }).then(q),
        sb.from('shift_mail_queue').insert({
          to_role: 'staff', to_cast: cut(cast, 60),
          subject: cut(p.subject || '【サクラシフト】通知', 300), html_body: cut(p.htmlBody, 20000),
        }).then(q),
        sb.from('shift_logs').insert(logRow({ type: 'CAST_SUBMIT', cast, detail: p.logDetail || '' }, cast)).then(q),
      ]);
      return { success: true };
    },

    async saveMaster(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      const data = parse(p.data);
      if(!data || typeof data !== 'object') return { error: 'INVALID_DATA' };
      q(await sb.from('shift_master').upsert({ id: 1, data }));
      // 設定変更の記録（キャストが減っていないか後から追える）
      sb.from('shift_logs').insert(logRow({ type: 'SAVE_MASTER',
        detail: 'キャスト' + ((data.castList || []).length) + '名 / 設定を保存' }, myName())).then(()=>{}, ()=>{});
      return { success: true };
    },

    async addLog(p){
      const x = p.data ? parse(p.data, {}) : p;
      if(!x || typeof x !== 'object') return { error: 'INVALID_DATA' };
      q(await sb.from('shift_logs').insert(logRow(x, myName())));
      return { success: true };
    },

    async addLogs(p){
      let arr = parse(p.data, []);
      if(!Array.isArray(arr)) return { error: 'INVALID_DATA' };
      if(!arr.length) return { success: true, added: 0 };
      arr = arr.slice(0, 500);
      q(await sb.from('shift_logs').insert(arr.map(x=>logRow(x || {}, myName()))));
      return { success: true, added: arr.length };
    },

    async addNotification(p, s){
      const role = p.role || 'staff';
      if(ROLE === 'cast' && role !== 'staff') return { error: 'FORBIDDEN', message: 'この操作はできません' };
      const castName = ROLE === 'cast' ? sessionCast(s) : (p.castName || '');
      q(await sb.from('shift_notifications').insert({
        id: 'n' + Date.now() + Math.floor(Math.random() * 1000),
        role, cast_name: cut(castName, 60), type: cut(p.type, 40), message: cut(p.message, 4000),
      }));
      return { success: true };
    },

    async deleteNotification(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      if(!p.notifId) return { error: 'NO_ID' };
      const rows = q(await sb.from('shift_notifications').delete().eq('id', p.notifId).select('id'));
      return { success: true, deleted: (rows || []).length };
    },

    async getNotifications(p, s){
      const role = p.role || 'staff';
      if(ROLE === 'cast'){
        if(role !== 'cast' || p.castName !== sessionCast(s)) return { error: 'FORBIDDEN' };
        return { notifications: await loadNotifications('cast', sessionCast(s)) };
      }
      return { notifications: await loadNotifications(role, p.castName || '') };
    },

    async getSentNotices(){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      const rows = q(await sb.from('shift_notifications').select('id,cast_name,message,created_at,read')
        .eq('role', 'cast').eq('type', 'notice').order('created_at', { ascending: false }).limit(1000));
      return { notices: rows.map(r=>({ id: r.id, castName: r.cast_name, message: r.message, createdAt: r.created_at, read: !!r.read })) };
    },

    async markRead(p, s){
      const castName = p.castName || '';
      if(ROLE === 'cast' && castName !== sessionCast(s)) return { error: 'FORBIDDEN' };
      const rows = q(await sb.from('shift_notifications').update({ read: true })
        .eq('role', 'cast').eq('cast_name', castName).eq('read', false).select('id'));
      return { success: true, updated: (rows || []).length };
    },

    // メールはすぐには送らず「順番待ち」に入れる（GAS が1分ごとに送る）
    async sendEmail(p){
      const toRole = p.toRole || '';
      if(ROLE === 'cast' && toRole !== 'staff') return { error: 'FORBIDDEN', message: 'この操作はできません' };
      if(toRole !== 'staff' && toRole !== 'cast') return { success: true, sent: 0, note: 'no_recipient' };
      q(await sb.from('shift_mail_queue').insert({
        to_role: toRole, to_cast: cut(p.toCast, 60),
        subject: cut(p.subject || '【サクラシフト】通知', 300), html_body: cut(p.htmlBody, 20000),
      }));
      return { success: true, sent: 1, queued: true };
    },

    async loadRecruitInfo(){ return { recruitInfo: await loadRecruit() }; },

    async saveRecruitInfo(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      const data = parse(p.data, {});
      if(!data || typeof data !== 'object') return { error: 'INVALID_DATA' };
      q(await sb.from('shift_recruit').upsert({ id: 1, data }));
      return { success: true };
    },

    async loadStaffNotes(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      return { notes: await loadNotes(list(p.weeks)) };
    },

    async saveStaffNotes(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      if(!p.wk) return { error: 'MISSING_PARAMS' };
      const data = parse(p.data, {});
      if(!data || typeof data !== 'object') return { error: 'INVALID_DATA' };
      q(await sb.from('shift_staff_notes').upsert({ wk: p.wk, data }));
      return { success: true };
    },

    async getLogs(){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      const rows = q(await sb.from('shift_logs').select('at,type,cast_name,week,detail,by_name')
        .order('id', { ascending: false }).limit(600));
      return { logs: rows.map(r=>({ time: r.at, type: r.type, cast: r.cast_name, week: r.week, detail: r.detail, by: r.by_name })) };
    },

    async getMyEmail(){
      if(ROLE !== 'cast') return { email: '' };
      return { email: q(await sb.rpc('shift_my_email')) || '' };
    },

    async saveCastEmail(p, s){
      if(ROLE === 'cast'){
        if(p.castName && p.castName !== sessionCast(s)) return { error: 'FORBIDDEN' };
        return q(await sb.rpc('shift_save_my_email', { p_email: p.email || '' }));
      }
      // 内勤：名簿の中のメールアドレスを書きかえる
      if(!p.castName) return { error: 'MISSING_PARAMS' };
      const m = await loadMaster();
      if(!m || !m.castList) return { error: 'MASTER_UNREADABLE', message: 'マスタが読み込めません' };
      m.settings = m.settings || {};
      m.settings.castEmails = m.settings.castEmails || {};
      if(p.email) m.settings.castEmails[p.castName] = p.email; else delete m.settings.castEmails[p.castName];
      q(await sb.from('shift_master').upsert({ id: 1, data: m }));
      return { success: true };
    },

    async deleteCast(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      return q(await sb.rpc('shift_delete_cast', { p_name: p.castName || '', p_by: myName() }));
    },

    async resetData(p){
      if(ROLE !== 'staff') return { error: 'FORBIDDEN' };
      return q(await sb.rpc('shift_reset_data', { p_target: p.target || 'all', p_by: myName() }));
    },
  };

  /* ---------- 入口 ---------- */
  async function call(params){
    const p = Object.assign({}, params || {});
    const fn = A[p.action];
    if(!fn) return { error: 'unknown action' };
    const s = await getSession();
    if(!s) return { error: 'SESSION_REQUIRED', message: 'ログインし直してください' };
    try{
      return await fn(p, s);
    }catch(e){
      if(isAuthErr(e)) return { error: 'SESSION_REQUIRED', message: 'ログインし直してください' };
      throw e;   // 通信エラーなどは今までどおり「失敗」として扱う（呼び出し側が再試行する）
    }
  }

  /* ---------- キャストのログイン・ログアウト ---------- */
  async function castLogin(name, pw){
    const n = String(name || '').trim();
    const { data, error } = await sb.auth.signInWithPassword({ email: await castEmail(n), password: await sha256(pw) });
    if(error){
      if(error.status === 429) return { error: 'LOCKED', message: '試行回数が上限に達しました。少し時間をおいてから、もう一度お試しください。' };
      if(error.status === 400 || error.status === 401) return { error: 'WRONG_PW', message: 'お名前かパスワードが違います' };
      throw error;
    }
    const cast = sessionCast(data && data.session);
    if(!cast){ await sb.auth.signOut({ scope: 'local' }); return { error: 'NOT_FOUND', message: '名前が見つかりません' }; }
    sb.from('shift_logs').insert(logRow({ type: 'LOGIN', cast, detail: 'ログイン（キャスト）' }, cast)).then(()=>{}, ()=>{});
    return { success: true, name: cast, role: 'cast' };
  }
  async function signOutLocal(){ try{ await sb.auth.signOut({ scope: 'local' }); }catch(e){} }

  window.ShiftDB = { call, getSession, sessionExpiresAt, sessionCast, castLogin, signOutLocal, client: sb };
})();
