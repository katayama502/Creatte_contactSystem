/**
 * Netlify Function: check-reminders
 * URL: /.netlify/functions/check-reminders
 *
 * 外部npm依存なし。Node.js組み込みのhttpsのみ使用。
 * Firebase REST API + LINE Messaging APIで動作します。
 *
 * 必要な Netlify 環境変数:
 *   LINE_CHANNEL_ACCESS_TOKEN  ... LINEチャネルアクセストークン
 *   FIREBASE_PROJECT_ID        ... Firebaseプロジェクト名 (例: creatte-contactsystem)
 *   FIREBASE_WEB_API_KEY       ... Firebase WebAPIキー (Firebaseコンソール > プロジェクト設定)
 *
 * cron-job.org などから毎時間このURLをPOSTしてください:
 *   https://あなたのサイト.netlify.app/.netlify/functions/check-reminders
 */

const https = require('https');

// HTTPS リクエスト汎用ラッパー
function request(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Firestore REST API でドキュメント一覧取得（APIキー認証）
async function getFirestoreDocs(projectId, apiKey, collectionName) {
    const path = `/v1/projects/${projectId}/databases/(default)/documents/${collectionName}?key=${apiKey}&pageSize=200`;
    const res = await request({ hostname: 'firestore.googleapis.com', path, method: 'GET' });
    if (res.status !== 200) {
        console.error('Firestore取得エラー:', res.body);
        return [];
    }
    const parsed = JSON.parse(res.body);
    return (parsed.documents || []).map(parseFirestoreDoc);
}

// Firestoreドキュメントをフラットなオブジェクトに変換
function parseFirestoreDoc(doc) {
    const fields = doc.fields || {};
    const result = {};
    for (const [key, val] of Object.entries(fields)) {
        if (val.stringValue !== undefined) result[key] = val.stringValue;
        else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
        else if (val.integerValue !== undefined) result[key] = Number(val.integerValue);
        else if (val.doubleValue !== undefined) result[key] = val.doubleValue;
        else result[key] = null;
    }
    result.__backendId = doc.name.split('/').pop();
    return result;
}

// LINE プッシュ送信
async function pushLine(userId, text, lineToken) {
    const body = JSON.stringify({ to: userId, messages: [{ type: 'text', text }] });
    return request({
        hostname: 'api.line.me',
        path: '/v2/bot/message/push',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${lineToken}`,
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
}

exports.handler = async (event, context) => {
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const apiKey = process.env.FIREBASE_WEB_API_KEY;

    if (!lineToken || !projectId || !apiKey) {
        const missing = [
            !lineToken && 'LINE_CHANNEL_ACCESS_TOKEN',
            !projectId && 'FIREBASE_PROJECT_ID',
            !apiKey && 'FIREBASE_WEB_API_KEY'
        ].filter(Boolean).join(', ');
        return { statusCode: 500, body: JSON.stringify({ error: `環境変数が不足: ${missing}` }) };
    }

    // Firestoreからデータ取得
    const allData = await getFirestoreDocs(projectId, apiKey, 'system_data');
    const schedules = allData.filter(d => d.type === 'schedule');
    const students = allData.filter(d => d.type === 'student');
    const settings = allData.find(d => d.type === 'reminder_settings') || {
        remind_24h: true,
        remind_3h: true,
        remind_1h: false,
        template_24h: '{生徒名}さん、授業のリマインドです。\n\n📅 {日時}\n📚 {科目}\n👨‍🏫 {担当講師}\n\nご予定の変更がある場合はご連絡ください。'
    };

    // 現在時刻（日本時間）
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

    const sent = [];
    const skipped = [];

    for (const schedule of schedules) {
        if (!schedule.schedule_date || !schedule.schedule_time || !schedule.student_name) continue;
        if (schedule.attendance === '完了' || schedule.attendance === '欠席') continue;

        // 授業の日時
        const classTime = new Date(`${schedule.schedule_date}T${schedule.schedule_time}:00+09:00`);
        const diffMin = Math.floor((classTime - now) / 60000);

        // リマインドタイミング判定（±15分の範囲）
        const is24h = settings.remind_24h && diffMin >= 1425 && diffMin <= 1455;
        const is3h = settings.remind_3h && diffMin >= 165 && diffMin <= 195;
        const is1h = settings.remind_1h && diffMin >= 45 && diffMin <= 75;

        if (!is24h && !is3h && !is1h) {
            skipped.push({ student: schedule.student_name, diffMin });
            continue;
        }

        // 学生のLINE ID
        const student = students.find(s => s.student_name === schedule.student_name);
        if (!student?.student_line_id) {
            console.warn(`LINE IDなし: ${schedule.student_name}`);
            continue;
        }

        const label = is24h ? '24時間前' : is3h ? '3時間前' : '1時間前';
        const dateStr = `${schedule.schedule_date} ${schedule.schedule_time}`;

        const messageBody = (settings.template_24h || '{生徒名}さん、授業リマインド\n📅{日時}\n📚{科目}')
            .replace('{生徒名}', schedule.student_name)
            .replace('{日時}', dateStr)
            .replace('{科目}', schedule.subject || '')
            .replace('{担当講師}', schedule.instructor || '');

        const text = `【授業リマインド - ${label}】\n${messageBody}`;

        const res = await pushLine(student.student_line_id, text, lineToken);
        sent.push({ student: schedule.student_name, label, lineStatus: res.status });
        console.log(`送信: ${schedule.student_name} (${label}) → LINE status ${res.status}`);
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: `${sent.length}件のリマインドを送信しました`,
            sent,
            skippedCount: skipped.length,
            checkedAt: now.toISOString()
        })
    };
};
