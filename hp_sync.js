/* ============================================================
   hp_sync.js … 受理（確認通知・変更の受理）のあとに、公式HPへ自動で入れる
   ------------------------------------------------------------
   1. 受理したら、そのキャストの在籍店舗の公式HPを読んで「この内容で公式HPに入れますか？」を出す
   2. 「入れる」→ ロボット（Supabase の hp-shift-sync）が管理画面に保存して『更新』まで
   3. うまく入ったお店は、入力チェックに自動で ✅（記録簿は受理した時点で自動で ✅）
   ※ ヘブン（サクラ・ラナ）・ぴゅあらば／口コミ情報局（キューティー・極門）も、媒体の出勤表の名前で探して入れる（10/22〜）
   ※ エイティーン・極門は、キャスト管理に入っているダミー名で管理画面のキャストを探して入れる（ダミー名がない子は入れない）
   ============================================================ */
(function(){
  // サクラシフトの媒体の名前 → 公式HPのお店（キャスト台帳の在籍店舗の key）
  const HP_STORES = {
    'サクラムーン': 'sakuramoon', 'ラナ鶯谷': 'lana_uguisu', 'ラナ錦糸町': 'lana_kinshi',
    'ドレスガーデン': 'dressgarden', 'ピーチムーン': 'peachmoon', 'キューティー': 'cutie', '逆AF倶楽部': 'gyakuanal',
  };
  // ダミー名のお店：キャスト管理に入っているダミー名で、管理画面のキャストを探す（ダミー名がない子は入れない）
  const DUMMY_STORES = { '18': 'eighteen', '極門': 'gokumon' };
  // 媒体（ヘブン・ぴゅあらば・口コミ情報局）：媒体の出勤表の名前で探す。alias = そのお店のダミー名で探す（極門）
  const MEDIA = {
    'ヘブンサクラ': { media: 'heaven', store: 'sakuramoon', label: 'ヘブン' },
    'ヘブンラナ': { media: 'heaven', store: 'lana_uguisu', label: 'ヘブン' },
    '(キュ)ぴゅあらば': { media: 'pure', store: 'cutie', label: 'ぴゅあらば' },
    '(キュ)情報局': { media: 'joho', store: 'cutie', label: '口コミ情報局' },
    '(極)ぴゅあらば': { media: 'pure', store: 'gokumon', label: 'ぴゅあらば', alias: '極門' },
    '(極)情報局': { media: 'joho', store: 'gokumon', label: '口コミ情報局', alias: '極門' },
  };
  // 在籍しているお店ぜんぶに入れる媒体（2026/11/01〜）：キャスト管理で「ぴゅあらば」「情報局」にチェックした子は、その子のお店ごとに入れる
  // ・お店ごとに別のID（Secrets：PURE_<お店>_ID・JOHO_<お店>_ID）。18・極門はダミー名で探す
  // ・キューティー・極門は、上の (キュ)(極) にもチェックがあればそちらで入れる（2回入れない）
  // ・入力チェックの ✅ は、その媒体のお店が全部うまく入ったときだけ
  const MULTI = { 'ぴゅあらば': { media: 'pure', label: 'ぴゅあらば' }, '情報局': { media: 'joho', label: '口コミ情報局' },
    'NHF': { media: 'nhf', label: 'NHF', not: ['極門', 'ドレスガーデン'] },
    'マンゾク': { media: 'manzoku', label: 'マンゾク', not: ['ドレスガーデン', 'キューティー', '極門'] },   // マンゾク（2026/11/22）
    '駅チカ': { media: 'ekichika', label: '駅チカ', not: ['ラナ鶯谷', 'キューティー', '18', '極門'] },   // 駅チカ（2026/11/22）
    '風じゃ': { media: 'fuja', label: '風俗じゃぱん', not: ['ラナ錦糸町', 'ピーチムーン', 'ドレスガーデン', 'キューティー', '極門'] },   // 風俗じゃぱん（2026/11/22）
    'デリじゃ': { media: 'delija', label: 'デリヘルじゃぱん', not: ['ラナ鶯谷', 'ラナ錦糸町', 'ピーチムーン', 'ドレスガーデン', 'キューティー', '18', '逆AF倶楽部'] } };   // デリヘルじゃぱん（サクラ・極門だけ）   // not = その媒体にのっていないお店
  const SHOP_KEYS = Object.assign({}, HP_STORES, DUMMY_STORES);
  function multiSpecs(m, castStores){
    const t = MULTI[m];
    const covered = Object.entries(MEDIA).filter(([k, v]) => castStores.includes(k) && v.media === t.media).map(([, v]) => v.store);
    return Object.entries(SHOP_KEYS).filter(([s, key]) => castStores.includes(s) && !covered.includes(key) && !(t.not || []).includes(s))
      .map(([s, key]) => ({ media: t.media, store: key, label: t.label, alias: DUMMY_STORES[s] ? s : undefined, shop: s }));
  }
  // 自動で ✅ にする媒体（新しい記録簿は 2026/11/3 から本番）
  const AUTO_MEDIA = ['記録簿'];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const DOW = '日月火水木金土';
  const md = ds => { const d = new Date(ds + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')'; };
  const hl = h => { h = Number(h); const x = h >= 24 ? h - 24 : h; return Math.floor(x) + ':' + String(Math.round((x % 1) * 60)).padStart(2, '0'); };
  function todayBiz(){ const j = new Date(Date.now() + 9 * 3600e3); if(j.getUTCHours() < 6) j.setUTCDate(j.getUTCDate() - 1); return j.toISOString().slice(0, 10); }
  let castCache = null;
  async function castRow(name){
    if(!castCache){
      const { data, error } = await ShiftDB.client.from('master_casts').select('id,official_name,shift_name,stores');
      if(error) throw error;
      castCache = data || [];
    }
    return castCache.find(c => c.shift_name === name) || castCache.find(c => c.official_name === name) || null;
  }
  // ロボットを一度にたくさん起こすと「Function failed to start」になるので、同時に動かすのは4つまで。起きられなかったら少し待って1回やりなおす
  let fnBusy = 0; const fnWait = [];
  async function callFn(body){
    if(fnBusy >= 4) await new Promise(res => fnWait.push(res));
    fnBusy++;
    try{
      for(let i = 0; ; i++){
        const { data, error } = await ShiftDB.client.functions.invoke('hp-shift-sync', { body });
        let r = data;
        if(error){ try{ r = await error.context.json(); }catch(e){ r = { ok: false, error: error.message }; } }
        r = r || { ok: false, error: '返事がありません' };
        const msg = String(r.error || r.message || '');
        const notStarted = /failed to start|BOOT_ERROR|WORKER_LIMIT/i.test(msg), readOnly = !/apply/.test(String(body.action || ''));   // 入れる（apply）は、起きられなかったときだけやりなおす
        if(i < 1 && !r.ok && (notStarted || (readOnly && /Failed to send|503|546/i.test(msg)))){ await new Promise(res => setTimeout(res, 1500)); continue; }
        return r;
      }
    }finally{ fnBusy--; const next = fnWait.shift(); if(next) next(); }
  }
  // その週のシフト → ロボットに渡す日ごとの予定（今日より前は入れない）
  function daysOf(w, wk){
    const today = todayBiz();
    return weekDates(wk).filter(ds => ds >= today).map(ds => {
      const s = w.shifts && w.shifts[ds];
      return s && s.start != null && s.end != null ? { date: ds, start: Number(s.start), end: Number(s.end) } : { date: ds, off: true, rest: typeof isChangedToRest === 'function' && isChangedToRest(w, ds) };
    });
  }
  // 「まだ入れられない日」（媒体・公式HPの画面にまだその日の欄がない）
  const WAIT_RE = /まだない日|の外なので/;
  // ★ 2026/11/25 店長：ロボットが今日「まだ入れられない」と言った日・媒体は、今日のあいだは「本日入力可能」に数えない（翌日また出る）
  //   このパソコンだけに覚える（localStorage）。キー＝キャスト|日付|媒体、中身＝その営業日
  const HpWait = (() => {
    const KEY = 'hpWait_v1';
    let map = {};
    try{ map = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }catch(e){ map = {}; }
    const today = todayBiz();
    Object.keys(map).forEach(k => { if(map[k] !== today) delete map[k]; });
    const save = () => { try{ localStorage.setItem(KEY, JSON.stringify(map)); }catch(e){} };
    save();
    return {
      add(cast, media, dates){ const t = todayBiz(); dates.forEach(ds => { map[cast + '|' + ds + '|' + media] = t; }); save(); },
      has(cast, ds, media){ return map[cast + '|' + ds + '|' + media] === todayBiz(); },
    };
  })();
  window.HpWait = HpWait;
  const waitDates = plans => { const s = new Set(); plans.forEach(p => (p.rows || []).forEach(z => { if(z.skip && WAIT_RE.test(z.skip)) s.add(z.date); })); return [...s]; };
  // 入れられなかった日（媒体の画面にまだない日・問題のある日）をのぞいた日
  function goodDays(days, plans){
    const bad = new Set();
    plans.forEach(p => (p.rows || []).forEach(z => { if(z.problem || z.skip) bad.add(z.date); }));
    return days.filter(d => !bad.has(d.date));
  }
  // 入力チェックをつける（ロボットで入ったお店・記録簿）
  function check(o, w, wk, media, days){
    let n = 0;
    days.forEach(d => {
      const target = !d.off || d.rest;   // 出勤日と「お休みに変更」の日がチェックの対象
      if(!target) return;
      const ck = w.checks && w.checks[d.date + '_' + media];
      if(ck && ck.checked) return;
      const r = Store.dispatch('SET_CHECK', { cast: o.cast, wk, ds: d.date, media, checked: true, by: o.by + '（自動）', color: o.color || '' });
      if(!r || !r.error) n++;
    });
    return n;
  }

  /* 受理のあとに呼ぶ：o = { cast, wk, by, color, after: async()=>{ 画面の描きなおし・保存 } } */
  async function offer(o){
    const w = Store.getWeek(o.cast, o.wk);
    // 小窓が出ないときは、理由を下に出す（何も起きないように見えないように）
    const say = msg => { if(o.manual) alert(msg); };   // ボタンで開いたときだけ（受理のときの自動は、入れる先がなければ何も出さない）
    if(!w){ say('この週のシフトが見つかりませんでした'); return; }
    const castStores = Store.getCastStores(o.cast) || [];
    const days = daysOf(w, o.wk);
    // AUTO_MEDIA の媒体は受理した時点で自動 ✅（記録簿）
    let autoN = 0;
    AUTO_MEDIA.filter(m => castStores.includes(m)).forEach(m => { autoN += check(o, w, o.wk, m, days); });
    if(autoN && o.after) await o.after();
    const targets = Object.keys(HP_STORES).concat(Object.keys(DUMMY_STORES), Object.keys(MEDIA), Object.keys(MULTI)).filter(m => castStores.includes(m));
    // 読む・入れる単位：お店・媒体ごと（ぴゅあらば・情報局は、その子のお店の数だけ）
    const jobs = targets.flatMap(m => MULTI[m] ? multiSpecs(m, castStores).map(t => ({ m, t })) : [{ m, t: MEDIA[m] }]);
    if(!days.length){ say('今日より前の週なので、入れる日がありません'); return; }
    if(!jobs.length){ say(o.cast + 'さんは、公式HP・媒体のチェック欄（入れる先）がありません'); return; }
    const modal = openModal(o);
    const closed = new Promise(res => { modal._done = res; });   // 閉じるまで待つ（一括のときは1人ずつ順番に）
    const body = modal.querySelector('.hp-body');
    let row;
    try{ row = await castRow(o.cast); }catch(e){ body.innerHTML = `<p class="hp-ng">キャスト台帳を読めませんでした：${esc(e.message || e)}</p>`; if(o.auto){ modal.remove(); return { ok: false, text: ["⚠️ キャスト台帳を読めませんでした"] }; } return closed; }
    const wdays = days.map(({ rest, ...d }) => d);
    let nDone = 0;
    body.innerHTML = `<p>公式HP・媒体を読んでいます…（お店はいっしょに読むので、1分ほど）</p>`;
    const one = async ({ m, t }) => {
      if(t){   // 媒体：媒体の出勤表の名前で探す（18・極門はダミー名）
        const disp = t.shop ? m + '（' + t.shop + '）' : '';
        const alias = t.alias ? ((Store.getCastAlias ? Store.getCastAlias(o.cast, t.alias) : '') || '') : '';
        if(t.alias && !alias) return { media: m, disp, kind: t.media, key: t.store, error: 'キャスト管理に' + t.alias + 'のダミー名が入っていないので入れません' };
        // 媒体の名前は公式HPと同じ → キャスト台帳の「そのお店の公式HPでの名前」→ 正式名 → サクラシフトの名前 の順に試す
        const st = row && row.stores && row.stores[t.store];
        const names = alias ? [alias] : [st && st.name, row && row.official_name, o.cast, ...Object.entries((row && row.stores) || {}).filter(([k]) => k !== 'eighteen' && k !== 'gokumon').map(([, x]) => x && x.name)].filter(Boolean);   // 最後に、ほかのお店での名前も（ダミー名のお店はのぞく：別の子に入らないように）
        const name = names[0];
        const r = await callFn({ action: 'media_preview', media: t.media, store: t.store, casts: [{ cast: o.cast, name, names, label: o.cast + (alias ? '（' + alias + '）' : ''), days: wdays }] });
        if(!r.ok) return { media: m, disp, kind: t.media, key: t.store, alias, error: r.error || r.message || r.code || '読めませんでした' };
        return { media: m, disp, kind: t.media, key: t.store, store: r.store, name: r.name, mname: r.name || name, rows: r.rows, alias };
      }
      if(DUMMY_STORES[m]){   // エイティーン・極門：ダミー名で探す
        const key = DUMMY_STORES[m], alias = (Store.getCastAlias ? Store.getCastAlias(o.cast, m) : '') || '';
        if(!alias) return { media: m, key, error: 'キャスト管理にダミー名が入っていないので入れません（入れるならキャスト管理でダミー名を入れてください）' };
        // 同じ名前が何人もいて、前に内勤が選んだ番号があれば、その番号で
        const picked = await pickedNo(key, o.cast);
        const r = await callFn({ action: 'preview', store: key, casts: [Object.assign(picked ? { no: picked } : { name: alias }, { label: o.cast + '（' + alias + '）', days: wdays })] });
        if(!r.ok) return { media: m, key, alias, error: r.error || r.message || r.code || '読めませんでした', candidates: r.candidates };
        const x = r.casts[0];
        return { media: m, key, no: x.no, store: r.store, name: x.name, rows: x.rows, error: x.error, alias, picked: !!picked };
      }
      const key = HP_STORES[m], no = row && row.stores && row.stores[key] && Number(row.stores[key].siteNo);
      if(!no){
        // 台帳に番号がない（新しいキャストなど）→ 管理画面のスケジュールの名前で探す。見つかったら台帳にも入れる（下の saveFoundNos）
        const st = row && row.stores && row.stores[key];
        const names = [...new Set([st && st.name, row && row.official_name, o.cast].filter(Boolean))];
        let lastErr = '';
        for(const name of names){
          const r = await callFn({ action: 'preview', store: key, casts: [{ name, label: o.cast, days: wdays }] });
          const x = r.ok && r.casts && r.casts[0];
          if(x && x.no) return { media: m, key, no: x.no, store: r.store, name: x.name, rows: x.rows, error: x.error, found: true };
          lastErr = r.error || r.message || '';
        }
        return { media: m, key, error: '公式HPの管理画面に「' + names.join('」「') + '」が見つかりませんでした。キャスト台帳に在籍番号を手で入れてください' + (/人います/.test(lastErr) ? '（' + lastErr + '）' : '') };
      }
      const r = await callFn({ action: 'preview', store: key, casts: [{ no, label: o.cast, days: wdays }] });
      if(!r.ok) return { media: m, key, no, error: r.error || r.message || r.code || '読めませんでした' };
      const x = r.casts[0];
      return { media: m, key, no, store: r.store, name: x.name, rows: x.rows, error: x.error };
    };
    // お店・媒体ごとに別々のロボットが読むので、いっしょに読む（順番は targets のまま）
    // マンゾクだけは1店ずつ順番に（同じIDのお店が同時にログインすると、前のほうが追い出される。11/22 ラナ鶯谷・錦糸町）
    let mzChain = Promise.resolve();
    const one0 = one;
    const oneSeq = j => { if(j.t && ['manzoku', 'fuja', 'delija'].includes(j.t.media)){ const p = mzChain.then(() => one0(j)); mzChain = p.catch(() => {}); return p; } return one0(j); };
    const plan0 = await Promise.all(jobs.map(j => oneSeq(j).catch(e => ({ media: j.m, disp: j.t && j.t.shop ? j.m + '（' + j.t.shop + '）' : '', error: String(e.message || e) })).then(p => {
      nDone++; body.innerHTML = `<p>公式HP・媒体を読んでいます…（${nDone}／${jobs.length}）</p>`; return p; })));
    // ぴゅあらば・情報局で、まだIDを入れていないお店は「準備中」としてとばす（エラーにしない・✅ のじゃまをしない）
    const idle = plan0.filter(p => MULTI[p.media] && /Secrets にありません/.test(p.error || ''));
    const plan = plan0.filter(p => !idle.includes(p));
    await saveFoundNos(o, row, plan);
    paintPlan(modal, o, w, days, plan);
    if(idle.length) body.insertAdjacentHTML('beforeend', `<p class="sub">⏸ IDがまだ入っていないので、とばしました：${idle.map(p => esc(p.disp || p.media)).join('、')}</p>`);
    // 🌐 まとめて入れる（o.auto）：確認しないで「入れる」を押して、終わったら小窓を閉じる（2026/11/22 店長）
    if(o.auto){
      const go = modal.querySelector('.btns .go');
      if(go && go.onclick) await go.onclick();
      const ng = body.querySelectorAll('.hp-ng').length + plan.filter(p => p.error).length;
      const text = [...body.querySelectorAll(':scope > .hp-ok, :scope > .hp-ng')].map(x => x.textContent.trim()).filter(Boolean);
      modal.remove(); if(modal._done) modal._done();
      return { ok: !ng, text };
    }
    return closed;
  }

  // 名前で見つけた在籍番号を、キャスト台帳に入れる（台帳にいない新しいキャストは、台帳に入れて サクラシフト・同じ名前のプロフ とつなぐ）
  // 台帳に入れられなくても、今回の公式HPへの反映はそのままできる
  async function saveFoundNos(o, row, plan){
    const found = plan.filter(p => p.found && p.no);
    if(!found.length) return;
    try{
      if(!row){
        let prof_id = null;
        try{
          const { data } = await ShiftDB.client.from('prof_casts').select('id').eq('name', o.cast).eq('deleted', false).limit(2);
          if(data && data.length === 1){
            const { data: used } = await ShiftDB.client.from('master_casts').select('id').eq('prof_id', data[0].id).limit(1);
            if(!used || !used.length) prof_id = data[0].id;   // ほかの台帳の人とつながっていないときだけ
          }
        }catch(e){}
        const stores = {}; found.forEach(p => { stores[p.key] = { siteNo: String(p.no) }; });
        const { data, error } = await ShiftDB.client.from('master_casts').insert({ official_name: o.cast, shift_name: o.cast, status: 'active', stores, prof_id })
          .select('id,official_name,shift_name,stores').single();
        if(!error && data && castCache) castCache.push(data);
        found.forEach(p => { p.note = error ? '' : 'キャスト台帳に入れて、在籍番号 ' + p.no + ' を入れました'; });
      }else{
        const stores = Object.assign({}, row.stores || {});
        found.forEach(p => { stores[p.key] = Object.assign({}, stores[p.key] || {}, { siteNo: String(p.no) }); });
        const { error } = await ShiftDB.client.from('master_casts').update({ stores }).eq('id', row.id);
        if(!error) row.stores = stores;
        found.forEach(p => { p.note = error ? '' : 'キャスト台帳に在籍番号 ' + p.no + ' を入れました'; });
      }
    }catch(e){}
  }

  // 同じ名前が何人もいるときに内勤が選んだ番号（hp_dummy_map）
  async function pickedNo(key, cast){
    try{ const { data } = await ShiftDB.client.from('hp_dummy_map').select('no').eq('store_key', key).eq('cast_name', cast).maybeSingle(); return data && data.no ? Number(data.no) : 0; }
    catch(e){ return 0; }
  }
  async function savePick(key, cast, no, by){
    const { error } = await ShiftDB.client.from('hp_dummy_map').upsert({ store_key: key, cast_name: cast, no, by_name: by || '', updated_at: new Date().toISOString() }, { onConflict: 'store_key,cast_name' });
    if(error) throw error;
  }
  async function clearPick(key, cast){ await ShiftDB.client.from('hp_dummy_map').delete().eq('store_key', key).eq('cast_name', cast); }
  // 小窓を開きなおす（番号を選んだ・選びなおしたあと）
  function reopen(modal, o){ const done = modal._done; modal.remove(); offer(o).then(() => { if(done) done(); }); }

  function openModal(o){
    const modal = document.createElement('div');
    modal.className = 'hp-modal';
    modal.innerHTML = `<style>
      .hp-modal{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45);}
      .hp-modal .box{background:#fff;border-radius:18px;padding:18px;max-width:720px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.3);font-size:14px;}
      .hp-modal h3{font-size:17px;margin-bottom:4px;} .hp-modal .sub{font-size:12px;color:#8a97a3;margin-bottom:10px;}
      .hp-modal table{border-collapse:collapse;width:100%;font-size:12.5px;margin:4px 0 10px;}
      .hp-modal th,.hp-modal td{border-bottom:1px solid #eef3f7;padding:4px 6px;text-align:left;white-space:nowrap;}
      .hp-modal th{color:#8a97a3;font-size:11.5px;background:#f6f9fb;}
      .hp-modal tr.chg td{background:#FFF6D6;} .hp-ng{color:#d9534f;font-weight:800;} .hp-ok{color:#1f9d6b;font-weight:800;}
      .hp-modal .st{font-weight:900;margin-top:10px;} .hp-modal .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
      .hp-modal button{border:none;border-radius:12px;padding:11px 16px;font-family:inherit;font-size:14px;font-weight:900;cursor:pointer;}
      .hp-modal .go{background:linear-gradient(135deg,#ff9fb8,#e5638c);color:#fff;} .hp-modal .no{background:#eef3f7;color:#5c6b77;}
    </style><div class="box"><h3>🌐 ${esc(o.cast)}さんのシフトを公式HP・媒体に入れますか？</h3>
      <div class="sub">${esc(md(weekDates(o.wk)[0]))}〜${esc(md(weekDates(o.wk)[6]))}／媒体は、媒体の出勤表の名前で探します</div>
      <div class="hp-body"></div><div class="btns"><button class="no" data-close>あとで（手で入れる）</button></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-close]').onclick = () => { modal.remove(); if(modal._done) modal._done(); };
    return modal;
  }

  function paintPlan(modal, o, w, days, plan){
    const body = modal.querySelector('.hp-body');
    const cell = v => v ? `${v.on ? '✅' : '⬜'} ${esc(v.start)}〜${esc(v.end)}` : '';
    let nChange = 0;
    body.innerHTML = plan.map((p, pi) => {
      // 同じ名前が何人もいる → 内勤が番号を選ぶ（選んだ番号は覚えておく）
      if(p.candidates && p.candidates.length) return `<div class="st">${esc(p.disp || p.media)}</div><div class="hp-ng">⚠️ ${esc(p.error)}</div>
        <div style="background:#FFF6D6;border-radius:10px;padding:8px 10px;margin:4px 0 8px">
          <div style="font-size:12.5px;margin-bottom:6px">${esc(o.cast)}さん（ダミー名「${esc(p.alias)}」）は、管理画面のどの番号の子ですか？ 選んだ番号は覚えておくので、次からは自動で入ります。</div>
          ${p.candidates.map(c => `<label style="display:block;font-size:13.5px;padding:2px 0"><input type="radio" name="pick${pi}" value="${c.no}"> ${esc(c.no)}番 ${esc(c.name)} ${c.onHp ? '<span class="hp-ok">（公式HPに出ている）</span>' : '<span style="color:#8a97a3">（公式HPには出ていない）</span>'}</label>`).join('')}
          <button type="button" class="go" style="margin-top:6px;padding:7px 14px;font-size:13px" data-pick="${pi}">この番号に決める</button></div>`;
      if(p.error) return `<div class="st">${esc(p.disp || p.media)}</div><div class="hp-ng">⚠️ ${esc(p.error)}</div>`;
      const ch = p.rows.filter(z => z.change && !z.problem && !z.skip).length; nChange += ch;
      return `<div class="st">${esc(p.store || p.media)} <small style="color:#8a97a3">（${p.kind ? '' : '公式HP ' + esc(p.no) + ' '}${esc(p.name)}）</small> ${ch ? `<span class="hp-ng">${ch}日 変わる</span>` : '<span class="hp-ok">同じ（変わらない）</span>'}
        ${p.picked ? `<a href="javascript:void(0)" data-repick="${pi}" style="font-size:12px;color:#C71585;margin-left:6px">番号を選びなおす</a>` : ''}</div>
        ${p.found ? `<div style="font-size:12px;color:#1a7f4b;margin:-2px 0 4px">🔎 名前で番号を見つけました${p.note ? '（' + esc(p.note) + '）' : ''}</div>` : ''}
        <table><tr><th>日</th><th>サクラシフト</th><th>${p.kind ? '今の媒体' : '今の公式HP'}</th><th>入れたあと</th><th></th></tr>
        ${p.rows.map(z => { const d = days.find(x => x.date === z.date) || {};
          return `<tr class="${z.change ? 'chg' : ''}"><td>${md(z.date)}</td><td>${d.off ? 'お休み' : hl(d.start) + '〜' + hl(d.end)}</td><td>${cell(z.now)}</td><td>${cell(z.next)}</td>
          <td>${z.skip ? (WAIT_RE.test(z.skip) ? `<span style="color:#8a97a3">⏳ まだ入れられない日（あとで）</span>` : `<span class="hp-ng">${esc(z.skip)}</span>`) : z.problem ? `<span class="hp-ng">⚠️ ${esc(z.problem)}</span>` : z.change ? '<b>変わる</b>' : 'そのまま'}</td></tr>`; }).join('')}</table>`;
    }).join('') + `<p class="sub" style="margin-top:6px">黄色の行が変わります。✅＝予（出勤予定）にチェック、⬜＝チェックなし</p>`;
    body.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => {
      const p = plan[+b.dataset.pick], r = body.querySelector(`input[name="pick${b.dataset.pick}"]:checked`);
      if(!r){ alert('番号を選んでください'); return; }
      try{ await savePick(p.key, o.cast, Number(r.value), o.by); reopen(modal, o); }
      catch(e){ alert('覚えておけませんでした（SQL 123 は実行ずみ？）：' + (e.message || e)); }
    });
    body.querySelectorAll('[data-repick]').forEach(a => a.onclick = async () => {
      const p = plan[+a.dataset.repick];
      if(!confirm(`${p.store || p.media} の番号（${p.no}番）を選びなおしますか？`)) return;
      try{ await clearPick(p.key, o.cast); }catch(e){}
      reopen(modal, o);
    });
    const btns = modal.querySelector('.btns');
    const okPlans = plan.filter(p => !p.error);
    if(!okPlans.length) return;
    const go = document.createElement('button');
    go.className = 'go';
    go.textContent = nChange ? '🌐 この内容で公式HP・媒体に入れる' : '✅ もう同じ内容（チェックだけつける）';
    btns.insertBefore(go, btns.firstChild);
    go.onclick = async () => {
      go.disabled = true; go.textContent = '入れています…（1分ほどかかることがあります）';
      const res = [];
      for(const p of okPlans){
        const need = p.rows.some(z => z.change && !z.problem && !z.skip);
        let ok = true, msg = '';
        if(need && p.kind){   // 媒体（ヘブン・ぴゅあらば・口コミ情報局）
          const r = await callFn({ action: 'media_apply', media: p.kind, store: p.key, by: o.by, casts: [{ cast: o.cast, name: p.mname, label: o.cast + (p.alias ? '（' + p.alias + '）' : ''), days: days.map(({ rest, ...d }) => d) }] });
          const x = r.results && r.results[0];
          ok = !!(r.ok && x && x.ok);
          if(!r.logged){
            try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: p.kind + ':' + p.key, store_label: p.store || p.media, by_name: o.by || '', cast_name: o.cast + (p.alias ? '（' + p.alias + '）' : ''),
              casts: [{ cast: o.cast, name: p.mname, label: o.cast, days: days.map(({ rest, ...d }) => d) }], ok: false, error_text: String(r.error || r.message || r.code || '返事がありませんでした') }); }catch(e){}
          }
          msg = ok ? x.changed + '日ぶん入れました' : ((x && x.failedDates && x.failedDates.length ? 'うまく入らなかった日 ' + x.failedDates.join('、') : '') || r.error || r.message || '入れられませんでした');
        } else if(need){
          const r = await callFn({ action: 'apply', store: p.key, by: o.by, casts: [{ cast: o.cast, no: p.no, label: o.cast + (p.alias ? '（' + p.alias + '）' : ''), days: days.map(({ rest, ...d }) => d) }] });
          const x = r.results && r.results[0];
          ok = !!(r.ok && x && x.ok);
          // ロボットまで届かなかった（通信エラーなど）ときは、こちらで記録を残す
          if(!r.logged){
            try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: p.key, store_label: p.store || p.media, by_name: o.by || '', cast_name: o.cast + (p.alias ? '（' + p.alias + '）' : ''),
              casts: [{ cast: o.cast, no: p.no, label: o.cast, days: days.map(({ rest, ...d }) => d) }], ok: false, error_text: String(r.error || r.message || r.code || '返事がありませんでした') }); }catch(e){}
          }
          msg = ok ? (x.changed + '日ぶん入れました' + (r.published && r.published.ok ? '・更新済み' : '（更新は管理画面で確認してください）')) : ((x && x.failedDates && x.failedDates.length ? 'うまく入らなかった日 ' + x.failedDates.join('、') : '') || r.error || r.message || '入れられませんでした');
        } else {
          msg = 'もう同じ内容でした';
          // 前に失敗した警告が残らないように、「同じ内容だった（入っている）」も成功として記録する
          if(!p.rows.some(z => z.problem || z.skip)){
            try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: p.kind ? p.kind + ':' + p.key : p.key, store_label: p.store || p.media, by_name: o.by || '', cast_name: o.cast + (p.alias ? '（' + p.alias + '）' : ''),
              casts: [{ cast: o.cast, no: p.no, name: p.mname, label: o.cast, days: days.map(({ rest, ...d }) => d) }], results: [{ ok: true, changed: 0 }], ok: true, error_text: 'もう同じ内容でした（確認だけ）' }); }catch(e){}
          }
        }
        // 入れたお店は、入力チェックに自動で ✅
        // 2026/11/25 店長：入れられなかった日（媒体の画面にまだない日・問題のある日）だけ ✅ をつけない。ほかの日はつける（前は1日でもあると全部つけなかった）
        const probs = p.rows.filter(z => z.problem || z.skip).length;
        let checked = 0;
        if(ok && !MULTI[p.media]) checked = check(o, Store.getWeek(o.cast, o.wk), o.wk, p.media, goodDays(days, [p]));   // ぴゅあらば・情報局は下で（お店が全部うまくいったときだけ）
        if(!MULTI[p.media]){ const wd = waitDates([p]); if(wd.length) HpWait.add(o.cast, p.media, wd); }
        res.push({ p, ok, msg, probs, checked });
      }
      Object.keys(MULTI).forEach(m => {
        const mine = res.filter(x => x.p.media === m);
        { const wd = waitDates(mine.map(x => x.p)); if(wd.length) HpWait.add(o.cast, m, wd); }
        if(!mine.length || plan.some(p => p.media === m && p.error) || !mine.every(x => x.ok)) return;
        mine[mine.length - 1].checked = check(o, Store.getWeek(o.cast, o.wk), o.wk, m, goodDays(days, mine.map(x => x.p)));   // どのお店でも入った日だけ
      });
      if(o.after) await o.after();
      // 入れられない日：媒体の画面にまだない日（情報局は28日先まで）だけなら「近くなったらもう一度」、ほかの理由なら「手で入れて」
      const probNote = p => { const bad = p.rows.filter(z => z.problem || z.skip), wait = bad.filter(z => WAIT_RE.test(z.skip || ''));
        return wait.length === bad.length
          ? `<br><span style="color:#8a97a3;font-weight:700">⏳ ${wait.map(z => md(z.date)).join('・')} はまだ入れられない日（近くなったら「本日入力可能」に出ます）</span>`
          : `<br><span class="hp-ng">⚠️ 入れられない日（${bad.map(z => md(z.date)).join('・')}）は、入力チェックをつけていません。手で入れてください</span>`; };
      body.innerHTML = res.map(x => `<div class="${x.ok ? 'hp-ok' : 'hp-ng'}">${x.ok ? '✅' : '❌'} ${esc(x.p.store || x.p.media)}：${esc(x.msg)}${x.checked ? `（入力チェック ${x.checked}日 ✅）` : ''}${x.probs ? probNote(x.p) : ''}</div>`).join('')
        + plan.filter(p => p.error).map(p => `<div class="hp-ng">⚠️ ${esc(p.disp || p.media)}：${esc(p.error)}</div>`).join('');
      go.remove();
      const close = modal.querySelector('[data-close]'); close.textContent = '閉じる'; close.className = 'go';
      refreshAlerts();   // 失敗があれば、受信ボックスの上の警告に出す
    };
  }

  /* ============================================================
     ⚠️ 公式HPに入らなかったシフトの警告（受信ボックスの上）
     記録（hp_sync_log）の 14日分から、キャスト×お店×週 ごとに いちばん新しい記録 を見て、失敗のままなら出す。
     もう一度入れて成功する／「✅ 手で入れた」を押す と消える
     ============================================================ */
  function mondayOf(ds){ const d = new Date(ds + 'T12:00:00'); const w = d.getDay(); d.setDate(d.getDate() + (w === 0 ? -6 : 1 - w)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  let alertRows = [];
  async function refreshAlerts(){
    try{
      const since = new Date(Date.now() - 14 * 86400e3).toISOString();
      const { data, error } = await ShiftDB.client.from('hp_sync_log').select('id,at,by_name,cast_name,store_key,store_label,casts,ok,error_text').gte('at', since).order('at', { ascending: false }).limit(500);
      if(error) return;
      const seen = new Set(); alertRows = [];
      (data || []).forEach(r => {
        const c = (r.casts && r.casts[0]) || {};
        const cast = c.cast || String(r.cast_name || '').replace(/（.*$/, '');
        const d0 = c.days && c.days[0] && c.days[0].date;
        const key = r.store_key + '|' + cast + '|' + (d0 ? mondayOf(d0) : '');
        if(seen.has(key)) return; seen.add(key);   // いちばん新しい記録だけ見る
        // 「出勤画面にない日（28日先まで）」だけの失敗は、日が近づけば入れられるので警告にしない（前のロボットの記録）
        if(r.ok === false && !rangeOnly(r)) alertRows.push(Object.assign({}, r, { cast, wk: d0 ? mondayOf(d0) : '' }));
      });
      paintAlerts();
    }catch(e){}
  }
  // 入れられる日の外（媒体のきまり）だけの失敗は、出さない（2026/11/29 店長「決まりきった事だからエラーにする必要がない」）
  //   ・口コミ情報局 28日先まで（前のロボットの記録）
  //   ・駅チカ：4日先からは保存しても入らない（11/28 の記録）→ 今のロボットは「まだ入れられない日」にしている
  const addDays = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function rangeOnly(r){
    const e = String(r.error_text || '');
    if(/出勤画面にない日です[^／]*28日先まで/.test(e)) return true;
    if(/^ekichika:/.test(String(r.store_key || ''))){
      const ds = [...new Set(e.match(/\d{4}-\d\d-\d\d/g) || [])], base = new Date(new Date(r.at).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
      return ds.length > 0 && ds.every(d => d >= addDays(base, 4));
    }
    return false;
  }
  // エラーを短く：なぜ（why）と、次にやること（act：retry＝もう一度入れる・report＝店長に報告・ok＝わかった）
  function shortWhy(e){
    e = String(e || '');
    if(/ログインでき|認証エラー|login/i.test(e)) return { why: 'ログインできませんでした', act: 'retry' };
    if(/5:50|6:30/.test(e)) return { why: '朝5:50〜6:30は入れられない時間でした', act: 'retry' };
    if(/ダミー名が入っていない/.test(e)) return { why: 'キャスト管理にダミー名がありません', act: 'ok' };
    if(/フォーム|形が変わ|門番|読めませんでした|parse/i.test(e)) return { why: 'ロボットが読めませんでした（媒体の画面が変わったかも）', act: 'report' };
    if(/がいません|見つかりません/.test(e)) return { why: 'この子が媒体に見つかりませんでした（名前がちがうかも）', act: 'retry' };
    if(/うまく入らなかった|『更新』|入らなかった/.test(e)) return { why: 'シフトが入りませんでした', act: 'retry' };
    if(/failed to start|Failed to send|BOOT_ERROR|WORKER|503|546|返事がありません|timeout|時間切れ/i.test(e)) return { why: 'ロボットが動けませんでした（混んでいたかも）', act: 'retry' };
    return { why: 'ロボットが読めませんでした（媒体の画面が変わったかも）', act: 'report' };
  }
  function paintAlerts(){ paintTodo(); }
  /* ============================================================
     ⚠️ やること（2026/11/29 店長）：入らなかったシフト（hp_sync_log）と、朝のチェックで見つけたものを、キャストごとに1つの枠に
     行 ＝ 期間・媒体・短い理由・次に押すボタン
     ============================================================ */
  const DIS_KEY = 'hpTodoDismiss_v1';
  const dismissed = () => { try{ return JSON.parse(localStorage.getItem(DIS_KEY) || '{}') || {}; }catch(e){ return {}; } };
  const dismiss = k => { const m = dismissed(); m[k] = todayBiz(); Object.keys(m).forEach(x => { if(m[x] < addDays(todayBiz(), -3)) delete m[x]; }); try{ localStorage.setItem(DIS_KEY, JSON.stringify(m)); }catch(e){} };
  function todoItems(){
    const items = [];
    const wkTxt = wk => { const ds = weekDates(wk); return md(ds[0]) + '〜' + md(ds[6]); };
    alertRows.forEach((r, i) => { const s = shortWhy(r.error_text); items.push({ cast: r.cast || r.cast_name, wk: r.wk, period: r.wk ? wkTxt(r.wk) : '', media: r.store_label || r.store_key, why: s.why, act: s.act, src: 'log', i, title: r.error_text || '' }); });
    if(audit && audit.run){
      const it = auditItems(audit), dm = dismissed();
      it.casts.forEach(c => c.list.forEach(x => {
        if(x.fixed) return;
        const wks = [...new Set(x.diffs.map(d => x.wk[d.date]).filter(Boolean))].sort();
        const cell = z => !z ? '？' : z.on ? (z.start || '') + '〜' + (z.end || '') : 'お休み';
        wks.forEach(wk => {
          const ds = x.diffs.filter(d => x.wk[d.date] === wk);
          items.push({ cast: c.cast, wk, period: ds.map(d => md(d.date)).join('・'), media: x.label, why: '朝のチェックで、入っていないシフトを見つけました', act: 'retry', src: 'audit',
            title: ds.map(d => `${md(d.date)} いま ${cell(d.now)} → シフト ${cell(d.want)}`).join('\n') });
        });
      }));
      it.errs.forEach(e => {
        const s = shortWhy(e.error), key = todayBiz() + '|' + (e.cast || '') + '|' + e.label;
        if(dm[key]) return;
        items.push({ cast: e.cast || '（お店ぜんぶ）', wk: '', period: '朝のチェック', media: e.label, why: s.why, act: s.act === 'report' ? 'report' : 'ok', src: 'auerr', key, title: e.error || '' });
      });
    }
    // 同じキャスト・同じ媒体・同じ理由・同じ期間は1つに
    const seen = new Set();
    return items.filter(x => { const k = [x.cast, x.media, x.why, x.period].join('|'); if(seen.has(k)) return false; seen.add(k); return true; });
  }
  function paintTodo(){
    let box = document.getElementById('hpTodo');
    const anchor = document.querySelector('.inbox-card');
    if(!anchor) return;
    ['hpAlert', 'hpAudit'].forEach(id => { const o = document.getElementById(id); if(o) o.remove(); });
    const items = todoItems();
    const a = audit, jobs = (a && a.jobs) || [];
    const running = !!(a && a.run && !a.run.finished_at);
    if(!items.length && !(a && a.run)){ if(box) box.remove(); return; }
    if(!box){ box = document.createElement('div'); box.id = 'hpTodo'; anchor.parentNode.insertBefore(box, anchor); }
    const nDone = jobs.filter(j => j.state === 'done' || j.state === 'error').length;
    const auLine = !(a && a.run) ? '' : running ? `🔎 けさのチェック：⏳ 調べています（${nDone}／${jobs.length}）` : `🔎 けさのチェック：済み${a.run.note ? '（' + esc(a.run.note) + '）' : ''}`;
    const casts = [...new Set(items.map(x => x.cast))];
    const can = typeof StaffApp !== 'undefined' && StaffApp.offerHpOne;
    const btn = (attr, txt, main) => `<button type="button" ${attr} style="border:${main ? 'none' : '1.5px solid #ddd'};border-radius:10px;padding:5px 11px;background:${main ? '#E5638C' : '#fff'};color:${main ? '#fff' : '#333'};font-weight:900;cursor:pointer;font-family:inherit;font-size:12.5px;white-space:nowrap">${txt}</button>`;
    const acts = (x, n) => {
      if(x.act === 'retry') return (x.wk && can ? btn(`data-tdretry="${n}"`, '🌐 もう一度入れる', true) : '') + (x.src === 'log' ? btn(`data-tdmanual="${n}"`, '✅ 手で入れた') : '');
      if(x.act === 'report') return '<small style="color:#C62828;font-weight:800">スクショを撮って店長に報告してください</small>' + btn(`data-tddone="${n}"`, '✅ 報告した');
      return btn(`data-tddone="${n}"`, '✅ わかった');
    };
    box.innerHTML = `<div style="background:${items.length ? '#FFF1F1' : '#EEF9F3'};border:2.5px solid ${items.length ? '#E5484D' : '#5BBF8E'};border-radius:16px;padding:10px 14px;margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div style="font-size:15px;font-weight:900;color:${items.length ? '#C62828' : '#1f7a52'};flex:1;min-width:200px">${items.length ? `⚠️ 公式HP・媒体でやること（${casts.length}人）` : '✅ 公式HP・媒体は全部シフトどおりです'}</div>
        ${can && items.some(x => x.act === 'retry' && x.wk) ? btn('id="tdAll"', '🌐 全部まとめて入れる', true) : ''}
        ${auLine ? `<small style="color:#7a8794;font-weight:800">${auLine}</small>` : ''}
        ${a && a.run && !running ? btn('id="auditAgain"', '🔄 もう一度しらべる') : ''}
      </div>
      ${casts.map(c => `<div class="td-cast" style="border-top:1px dashed #F3B7B9;padding:6px 0 4px">
        <div style="font-weight:900;font-size:14.5px;margin-bottom:2px">${esc(c)}</div>
        ${items.map((x, n) => x.cast !== c ? '' : `<div class="td-row" title="${esc(x.title || '')}" style="display:grid;grid-template-columns:minmax(90px,max-content) minmax(110px,max-content) 1fr auto;gap:4px 10px;align-items:center;font-size:13px;padding:3px 0 3px 8px">
          <span style="color:#6b7785">${esc(x.period)}</span><b>${esc(x.media)}</b><span style="color:#C62828;font-weight:800">${esc(x.why)}</span><span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end">${acts(x, n)}</span></div>`).join('')}
      </div>`).join('')}
    </div>
    <style>@media (max-width:640px){ #hpTodo .td-row{grid-template-columns:auto 1fr !important} #hpTodo .td-row > span:nth-child(3),#hpTodo .td-row > span:nth-child(4){grid-column:1 / -1} }</style>`;
    box.querySelectorAll('[data-tdretry]').forEach(b => b.onclick = () => { const x = items[+b.dataset.tdretry]; Promise.resolve(StaffApp.offerHpOne(x.cast, x.wk)).then(() => setTimeout(() => { refreshAlerts(); refreshAudit(); }, 1500)); });
    box.querySelectorAll('[data-tdmanual]').forEach(b => b.onclick = async () => {
      const x = items[+b.dataset.tdmanual], r = alertRows[x.i];
      if(!confirm(`${x.cast} → ${x.media}\n管理画面で手で入れましたか？（ここから消します）`)) return;
      const sel = document.getElementById('staffSelect');
      try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: r.store_key, store_label: r.store_label, by_name: (sel && sel.value) || '', cast_name: r.cast_name, casts: r.casts, ok: true, error_text: '手で入れた（記録だけ）' }); }catch(e){}
      refreshAlerts();
    });
    box.querySelectorAll('[data-tddone]').forEach(b => b.onclick = async () => {
      const x = items[+b.dataset.tddone];
      if(x.src === 'log'){
        const r = alertRows[x.i], sel = document.getElementById('staffSelect');
        try{ await ShiftDB.client.from('hp_sync_log').insert({ store_key: r.store_key, store_label: r.store_label, by_name: (sel && sel.value) || '', cast_name: r.cast_name, casts: r.casts, ok: true, error_text: '報告した（記録だけ）' }); }catch(e){}
        refreshAlerts();
      } else { dismiss(x.key); paintTodo(); }
    });
    const all = box.querySelector('#tdAll'); if(all) all.onclick = () => fixAll(false);
    const ag = box.querySelector('#auditAgain'); if(ag) ag.onclick = async () => {
      if(!confirm('もう一度、全員の公式HP・媒体を見くらべますか？（30分〜1時間かかります。朝7時より前はできません）')) return;
      const { error } = await ShiftDB.client.rpc('shift_audit_restart');
      if(error){ alert('できませんでした：' + (error.message || error)); return; }
      audit = { run: null, jobs: [] }; paintTodo(); setTimeout(refreshAudit, 70000);
    };
  }
  setTimeout(refreshAlerts, 3000);
  setInterval(refreshAlerts, 180000);   // 3分ごと（ほかの内勤が入れた結果も出る）

  /* ============================================================
     🌐 入れる待ち（2026/11/22 店長）：受理しても小窓は出さず「入れる待ち」にためる（hp_sync_queue・SQL 940）
     「🌐 まとめて入れる」で、1人ずつ順番に確認なしで入れる（変わるところだけ・入ったら自動 ✅）。終わったら結果の一覧
     ※ 記録簿の ✅ は、ためた時点でつける（今までどおり受理したとき）
     ============================================================ */
  let queueRows = [], queueRunning = false, queueLog = [];
  const ctx = () => (window.HpSync && HpSync.ctx ? HpSync.ctx() : {});
  async function enqueue(list){
    const c = ctx();
    const rows = list.map(it => ({ cast_name: it.cast, wk: it.wk, added_by: c.by || '' }));
    const { error } = await ShiftDB.client.from('hp_sync_queue').upsert(rows, { onConflict: 'cast_name,wk' });
    if(error){ enqueue.lastError = error.message || String(error); return false; }   // SQL 940 がまだ → 今までどおり小窓で
    let autoN = 0;
    for(const it of list){
      const w = Store.getWeek(it.cast, it.wk); if(!w) continue;
      const cs = Store.getCastStores(it.cast) || [], days = daysOf(w, it.wk);
      AUTO_MEDIA.filter(m => cs.includes(m)).forEach(m => { autoN += check({ cast: it.cast, by: c.by || '', color: c.color || '' }, w, it.wk, m, days); });
    }
    if(autoN && c.after) await c.after();
    await refreshQueue();
    return true;
  }
  async function refreshQueue(){
    try{
      const { data, error } = await ShiftDB.client.from('hp_sync_queue').select('*').order('added_at');
      if(error) return;
      queueRows = data || [];
      paintQueue();
    }catch(e){}
  }
  function paintQueue(){
    let box = document.getElementById('hpQueue');
    const anchor = document.getElementById('hpTodo') || document.querySelector('.inbox-card');
    if(!anchor) return;
    if(!queueRows.length && !queueRunning && !queueLog.length){ if(box) box.remove(); return; }
    if(!box){ box = document.createElement('div'); box.id = 'hpQueue'; anchor.parentNode.insertBefore(box, anchor); }
    const wkTxt = wk => { const ds = weekDates(wk); return md(ds[0]) + '〜' + md(ds[6]); };
    box.innerHTML = `<div style="background:#F3F0FF;border:2.5px solid #7C6CD8;border-radius:16px;padding:12px 14px;margin-bottom:12px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="font-size:15px;font-weight:900;color:#4B3A8A">🌐 公式HP・媒体に入れる待ち（${queueRows.length}人）</div>
        ${queueRows.length && !queueRunning ? `<button type="button" id="hpQueueGo" style="border:none;border-radius:12px;padding:9px 16px;background:linear-gradient(135deg,#9C8CF0,#6B5BB8);color:#fff;font-weight:900;cursor:pointer;font-family:inherit;font-size:14px">🌐 まとめて入れる</button>` : ''}
        ${queueRunning ? `<b style="color:#6B5BB8">⏳ 入れています… ${esc(queueRunning)}（この画面を閉じないでください）</b>` : ''}
      </div>
      <div style="font-size:12px;color:#6B5B8A;margin:4px 0 6px">受理した週がここにたまります。「まとめて入れる」で、1人ずつ確認なしで入れます（1人1〜2分。入れているあいだは、この画面を開いたままにしてください）。</div>
      ${queueRows.map((r, i) => `<span style="display:inline-flex;gap:6px;align-items:center;background:#fff;border:1.5px solid #D9D1FF;border-radius:99px;padding:3px 6px 3px 12px;margin:2px 4px 2px 0;font-size:13px">
        <b>${esc(r.cast_name)}</b><small style="color:#8a97a3">${esc(wkTxt(r.wk))}</small>
        ${queueRunning ? '' : `<a href="javascript:void 0" data-qone="${i}" title="この子だけ、確認しながら入れる" style="text-decoration:none">🔍</a><a href="javascript:void 0" data-qdel="${i}" title="待ちから外す" style="text-decoration:none;color:#9C8B8F">✕</a>`}</span>`).join('')}
      ${queueLog.length ? `<div style="margin-top:8px;border-top:1px dashed #D9D1FF;padding-top:6px;font-size:12.5px;color:#1f9d6b;font-weight:800">✅ ${queueLog.length}人 入れ終わりました${queueRunning ? '' : '（入らなかったところは、下の「⚠️ やること」に出ます）'} 
        ${queueRunning ? '' : `<a href="javascript:void 0" id="hpQueueClr" style="font-size:12px;color:#8a97a3">結果を消す</a>`}</div>` : ''}</div>`;
    const g = box.querySelector('#hpQueueGo'); if(g) g.onclick = runQueue;
    const cl = box.querySelector('#hpQueueClr'); if(cl) cl.onclick = () => { queueLog = []; paintQueue(); };
    box.querySelectorAll('[data-qdel]').forEach(a => a.onclick = async () => {
      const r = queueRows[+a.dataset.qdel]; if(!confirm(`${r.cast_name}（${wkTxt(r.wk)}）を「入れる待ち」から外しますか？\n（公式HP・媒体には入れません。入れるときは週のカードの 🌐 から）`)) return;
      await ShiftDB.client.from('hp_sync_queue').delete().eq('cast_name', r.cast_name).eq('wk', r.wk); refreshQueue();
    });
    box.querySelectorAll('[data-qone]').forEach(a => a.onclick = async () => {
      const r = queueRows[+a.dataset.qone], c = ctx();
      await offer({ cast: r.cast_name, wk: r.wk, manual: true, by: c.by, color: c.color, after: c.after });
      await ShiftDB.client.from('hp_sync_queue').delete().eq('cast_name', r.cast_name).eq('wk', r.wk); refreshQueue();
    });
  }
  async function runQueue(noAsk){
    if(queueRunning) return;
    await refreshQueue();
    const list = queueRows.slice(); if(!list.length) return;
    if(noAsk !== true && !confirm(`${list.length}人を、確認なしで公式HP・媒体に入れます。\n終わるまで、この画面を開いたままにしてください（1人1〜2分）。`)) return;
    queueLog = [];
    for(let i = 0; i < list.length; i++){
      const r = list[i], c = ctx();
      queueRunning = `${i + 1}／${list.length}人目：${r.cast_name}`; paintQueue();
      let res;
      try{ res = await offer({ cast: r.cast_name, wk: r.wk, auto: true, by: c.by, color: c.color, after: c.after }); }
      catch(e){ res = { ok: false, text: ['⚠️ ' + (e.message || e)] }; }
      if(!res) res = { ok: true, text: [] };   // 入れる先がない・今日より前の週
      queueLog.push({ cast: r.cast_name, wk: r.wk, ok: res.ok, text: res.text || [] });
      try{ await ShiftDB.client.from('hp_sync_queue').delete().eq('cast_name', r.cast_name).eq('wk', r.wk); }catch(e){}
      queueRows = queueRows.filter(x => !(x.cast_name === r.cast_name && x.wk === r.wk));
    }
    queueRunning = false;
    await refreshQueue(); refreshAlerts();
  }
  setTimeout(refreshQueue, 3500);
  setInterval(() => { if(!queueRunning) refreshQueue(); }, 60000);   // ほかの内勤がためた分も出る

  /* ============================================================
     🔎 毎朝のシフトチェック（2026/11/29 店長）：朝7時からロボットが、受理ずみのシフト（今日〜13日先）と
     公式HP・媒体の出勤を見くらべた結果（SQL 981・hp-shift-sync の audit_tick）。ちがうところを出す
     ・「🌐 入れる」で、その子の週をいつもの小窓で入れなおす。入れたあとは「✅ そのあと入れました」になる
     ============================================================ */
  let audit = null;
  async function refreshAudit(){
    try{
      const day = todayBiz(), db = ShiftDB.client;
      const { data: run, error } = await db.from('shift_audit_runs').select('*').eq('run_date', day).maybeSingle();
      if(error){ audit = null; paintAudit(); return; }   // SQL 981 がまだ
      if(!run){ audit = { run: null, jobs: [] }; paintAudit(); return; }
      const { data: jobs } = await db.from('shift_audit_jobs').select('id,kind,store,label,state,finished_at,result,error').eq('run_date', day).order('id');
      const { data: logs } = await db.from('hp_sync_log').select('at,store_key,casts,ok').gte('at', run.created_at).eq('ok', true).limit(1000);
      audit = { run, jobs: jobs || [], logs: logs || [] };
      paintAudit();
    }catch(e){}
  }
  // 結果 → キャストごとの「ちがうところ」と「読めなかったところ」。そのあと「🌐 入れる」で入った（hp_sync_log の ok）ものは fixed
  function auditItems(a){
    const byCast = new Map(), errs = [];
    (a.jobs || []).forEach(j => {
      const r = j.result || {}, key = j.kind === 'hp' ? j.store : j.kind + ':' + j.store;
      if(j.state === 'error' && !(r.errors || []).length) errs.push({ cast: '', label: j.label, error: j.error || '読めませんでした' });
      (r.errors || []).forEach(e => errs.push({ cast: e.cast, label: j.label, error: e.error }));
      (r.issues || []).forEach(is => {
        const fixed = (a.logs || []).some(l => l.store_key === key && String(l.at) > String(j.finished_at || '') && (l.casts || []).some(c => c && c.cast === is.cast));
        if(!byCast.has(is.cast)) byCast.set(is.cast, []);
        byCast.get(is.cast).push({ label: j.label, diffs: is.diffs || [], wk: is.wk || {}, fixed });
      });
    });
    return { casts: [...byCast.entries()].map(([cast, list]) => ({ cast, list, fixed: list.every(x => x.fixed) })), errs };
  }
  function paintAudit(){ paintTodo(); }
  setTimeout(refreshAudit, 4000);
  setInterval(refreshAudit, 180000);   // 3分ごと（調べている途中の進み具合・ほかの内勤が入れた結果も出る）

  /* ============================================================
     🌐 ボタン1つで全部入れる（2026/11/29 店長）：「やること」の「もう一度入れる」の子・週を、入れる待ちにためて、まとめて入れる
     ・記録簿の「📢 お知らせ」のボタン → サクラシフトが #hpfix で開く → 自動でこれが始まる（確認は1回だけ）
     ・朝のチェックは、今日から入れられるようになった日（駅チカ・情報局など）も「入っていない」として見つけるので、それもここで入る
     ============================================================ */
  async function fixAll(fromLink){
    await refreshAlerts(); await refreshAudit();
    const seen = new Set(), list = [];
    todoItems().filter(x => x.act === 'retry' && x.wk).forEach(x => { const k = x.cast + '|' + x.wk; if(!seen.has(k)){ seen.add(k); list.push({ cast: x.cast, wk: x.wk }); } });
    if(!list.length){ if(fromLink) alert('入れるものはありませんでした ✨（公式HP・媒体はシフトどおりです）'); return; }
    const names = [...new Set(list.map(x => x.cast))];
    if(!confirm(`公式HP・媒体に入っていない ${names.length}人（${names.join('・')}）を、まとめて入れます。\n終わるまで、この画面を開いたままにしてください（1人1〜2分）。`)) return;
    if(!(await enqueue(list))){ alert('入れる待ちにためられませんでした：' + (enqueue.lastError || '')); return; }
    await runQueue(true);
    await refreshAlerts(); setTimeout(refreshAudit, 1500);
  }
  // 記録簿から #hpfix で開いたとき：画面の準備ができたら始める
  if(/hpfix/.test(location.hash + location.search)){
    (async () => {
      try{ history.replaceState(null, '', location.pathname); }catch(e){}
      for(let i = 0; i < 60 && !(window.StaffApp && StaffApp.offerHpOne && HpSync.ctx && document.querySelector('.inbox-card')); i++) await new Promise(r => setTimeout(r, 500));
      await new Promise(r => setTimeout(r, 2500));   // シフトを読み終わるのを待つ
      fixAll(true);
    })();
  }

  // いま「入れる待ち」に人がいる・入れている途中・確認の小窓が開いている → 新しく受理した子は待ちにためる（2026/11/22 店長）
  const busy = () => queueRows.length > 0 || !!queueRunning || !!document.querySelector('.hp-modal');
  window.HpSync = { offer, fixAll, HP_STORES, refreshAlerts, enqueue, refreshQueue, runQueue, busy, refreshAudit, auditItems, _setAudit: a => { audit = a; paintAudit(); } };
})();
