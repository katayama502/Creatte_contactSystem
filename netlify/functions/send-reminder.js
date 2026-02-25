/**
 * Netlify Function: LINE リマインド一括送信
 * URL: /.netlify/functions/send-reminder
 * 
 * Netlify Scheduledで定期実行するか、手動でAPIコールして使用。
 * 使用例: POST /.netlify/functions/send-reminder
 * Body: { "students": [...], "message": "..." }
 */

const https = require('https');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!accessToken) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'LINE_CHANNEL_ACCESS_TOKEN が設定されていません' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { userIds, message } = body;

    if (!userIds || !Array.isArray(userIds) || !message) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'userIds (配列) と message が必要です' })
        };
    }

    const results = [];
    for (const userId of userIds) {
        try {
            await pushMessage(userId, message, accessToken);
            results.push({ userId, status: 'success' });
        } catch (err) {
            results.push({ userId, status: 'error', error: err.message });
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ results })
    };
};

function pushMessage(userId, text, accessToken) {
    const data = JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text }]
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.line.me',
            path: '/v2/bot/message/push',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(body);
                } else {
                    reject(new Error(`LINE API error: ${res.statusCode} ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}
