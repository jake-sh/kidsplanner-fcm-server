const express = require('express');
const admin   = require('firebase-admin');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const qs      = require('querystring');

// ── Firebase 초기화 ──────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Express 설정 ─────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── 헬퍼: HTTPS 요청 ─────────────────────────────
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ── 쿠키 파싱 ────────────────────────────────────
function parseCookies(setCookieArr) {
  const cookies = {};
  (setCookieArr || []).forEach(c => {
    const part = c.split(';')[0];
    const [k, v] = part.split('=');
    if (k) cookies[k.trim()] = (v || '').trim();
  });
  return cookies;
}

function cookieStr(cookies) {
  return Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join('; ');
}

// ── HTML 파서 (VIEWSTATE 추출) ────────────────────
function extractHidden(html, name) {
  const re = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i');
  const m  = html.match(re) || html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`, 'i'));
  return m ? m[1] : '';
}

// ── 이미지 제거 후 텍스트만 추출 ─────────────────
function cleanText(html) {
  return html
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 비바키즈 크롤러 ───────────────────────────────
const BIBAKIDS_HOST = 'www.bibakids.co.kr';
const USERID  = process.env.BIBAKIDS_ID;
const USERPWD = process.env.BIBAKIDS_PWD;

async function crawl() {
  console.log('[크롤러] 시작', new Date().toISOString());
  let cookies = {};

  // 1. 로그인 페이지 GET → VIEWSTATE 추출
  const getRes = await httpsRequest({
    hostname: BIBAKIDS_HOST, path: '/', method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' }
  });
  Object.assign(cookies, parseCookies(getRes.headers['set-cookie']));

  const vs  = extractHidden(getRes.body, '__VIEWSTATE');
  const vsg = extractHidden(getRes.body, '__VIEWSTATEGENERATOR');
  const ev  = extractHidden(getRes.body, '__EVENTVALIDATION');

  // 2. 로그인 POST
  const loginData = qs.stringify({
    __VIEWSTATE: vs, __VIEWSTATEGENERATOR: vsg, __EVENTVALIDATION: ev,
    txtmainid: USERID, txtmainpwd: USERPWD,
    'imgMainLogin.x': '48', 'imgMainLogin.y': '18'
  });
  const loginRes = await httpsRequest({
    hostname: BIBAKIDS_HOST, path: '/', method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(loginData),
      'Cookie': cookieStr(cookies),
      'User-Agent': 'Mozilla/5.0'
    }
  }, loginData);
  Object.assign(cookies, parseCookies(loginRes.headers['set-cookie']));

  // JS 리다이렉트 따라가기
  const redirMatch = loginRes.body.match(/document\.location\.href='([^']+)'/);
  if (redirMatch) {
    const redirRes = await httpsRequest({
      hostname: BIBAKIDS_HOST, path: '/' + redirMatch[1], method: 'GET',
      headers: { 'Cookie': cookieStr(cookies), 'User-Agent': 'Mozilla/5.0' }
    });
    Object.assign(cookies, parseCookies(redirRes.headers['set-cookie']));
  }

  console.log('[크롤러] 로그인 완료');

  // 3. 알림장 페이지 → 학생 목록 추출
  const noticePageRes = await httpsRequest({
    hostname: BIBAKIDS_HOST, path: '/mypage/sub09_02.aspx', method: 'GET',
    headers: { 'Cookie': cookieStr(cookies), 'User-Agent': 'Mozilla/5.0' }
  });
  Object.assign(cookies, parseCookies(noticePageRes.headers['set-cookie']));

  // 학생 목록
  const students = [];
  const optRe = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/gi;
  let optMatch;
  const html = noticePageRes.body;
  const selStart = html.indexOf('id="cmbstudent"');
  const selEnd   = html.indexOf('</select>', selStart);
  const selHtml  = selStart >= 0 ? html.slice(selStart, selEnd) : '';
  while ((optMatch = optRe.exec(selHtml)) !== null) {
    students.push({ mpidx: optMatch[1], name: optMatch[2].trim() });
  }

  // 년월
  const ymMatch = html.match(/id="spnYear"[^>]*>(\d{4})<\/span>[\s\S]*?id="spnMon"[^>]*>(\d{2})<\/span>/);
  const ym = ymMatch ? ymMatch[1] + ymMatch[2] : new Date().toISOString().slice(0,7).replace('-','');

  console.log('[크롤러] 학생:', students.map(s=>s.name), '년월:', ym);

  const today = new Date().toISOString().slice(0,10);
  let totalSaved = 0;

  for (const student of students) {
    // 4. Ajax로 알림장 데이터 요청
    const ajaxData = qs.stringify({
      cmd: 'GetNoticeList', MpIdx: student.mpidx, wDate: ym, Page: '1'
    });
    const ajaxRes = await httpsRequest({
      hostname: BIBAKIDS_HOST, path: '/mypage/Ajax.aspx', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(ajaxData),
        'Cookie': cookieStr(cookies),
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.bibakids.co.kr/mypage/sub09_02.aspx',
        'User-Agent': 'Mozilla/5.0'
      }
    }, ajaxData);

    const htmlPart = ajaxRes.body.split('|^|')[0];

    // tr/td 파싱
    const notices = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRe.exec(htmlPart)) !== null) {
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const tds  = [];
      let tdMatch;
      while ((tdMatch = tdRe.exec(trMatch[1])) !== null) tds.push(tdMatch[1]);
      if (tds.length >= 3) {
        const date    = cleanText(tds[0]);
        const subject = cleanText(tds[1]);
        const content = cleanText(tds[2]);
        if (date && content) notices.push({ date, subject, content });
      }
    }

    console.log(`[크롤러] ${student.name}: ${notices.length}개`);

    // 5. Firestore 저장
    const batch = db.batch();
    let saved = 0;
    for (const n of notices) {
      const docId = `${student.name}_${n.date}_${n.subject.slice(0,10)}`
        .replace(/\s+/g,'_').replace(/[\/\\]/g,'_');
      const ref = db.collection('alimjang').doc(docId);
      const existing = await ref.get();
      if (!existing.exists) {
        batch.set(ref, {
          student: student.name, date: n.date,
          subject: n.subject, content: n.content,
          savedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        saved++;
      }
    }
    if (saved > 0) await batch.commit();

    // 6. alimjang_today 업데이트 (최신 데이터)
    const latest = notices[0] || null;
    if (latest) {
      await db.collection('alimjang_today').doc(student.name).set({
        student: student.name,
        date:    latest.date,
        notices: notices,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    totalSaved += saved;
  }

  console.log(`[크롤러] 완료: ${totalSaved}개 신규 저장`);
  return { ok: true, saved: totalSaved, students: students.map(s=>s.name) };
}

// ── API 엔드포인트 ────────────────────────────────

// FCM 푸시
app.post('/', async (req, res) => {
  try {
    const { token, title, body } = req.body;
    if (!token) return res.status(400).json({ error: 'no token' });
    await admin.messaging().send({
      token,
      notification: { title, body },
      webpush: { fcmOptions: { link: '/' } }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 크롤링 (cron-job.org 또는 앱에서 호출)
app.get('/crawl', async (req, res) => {
  try {
    const result = await crawl();
    res.json(result);
  } catch (e) {
    console.error('[크롤러 오류]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 슬립 방지용 ping
app.get('/', (req, res) => res.send('Kids Planner Server OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on ' + PORT));
