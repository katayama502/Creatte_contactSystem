/**
 * Netlify Function: LINE Messaging API Webhook handler
 * URL: /.netlify/functions/webhook
 * 
 * このWebhook URLをLINE Developersコンソールに設定してください。
 */

const crypto = require('crypto');

exports.handler = async (event, context) => {
  // LINE からの POST リクエストのみ受け付ける
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!channelSecret || !accessToken) {
    console.error('LINE環境変数が設定されていません');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error' })
    };
  }

  // 署名検証（セキュリティ）
  const signature = event.headers['x-line-signature'];
  const body = event.body;

  if (!verifySignature(channelSecret, body, signature)) {
    console.error('署名検証失敗');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' })
    };
  }

  let webhookData;
  try {
    webhookData = JSON.parse(body);
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  // LINEイベントを処理
  const events = webhookData.events || [];
  
  for (const lineEvent of events) {
    try {
      await handleLineEvent(lineEvent, accessToken);
    } catch (err) {
      console.error('イベント処理エラー:', err);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ status: 'ok' })
  };
};

/**
 * LINE署名検証
 */
function verifySignature(channelSecret, body, signature) {
  if (!signature) return false;
  const hash = crypto
    .createHmac('SHA256', channelSecret)
    .update(body)
    .digest('base64');
  return hash === signature;
}

/**
 * LINE イベント処理
 */
async function handleLineEvent(event, accessToken) {
  const { type, replyToken, source, message } = event;

  if (type === 'message' && message?.type === 'text') {
    const userId = source?.userId;
    const text = message.text;
    console.log(`メッセージ受信 [${userId}]: ${text}`);

    // 自動返信メッセージ
    let replyText = '';
    
    if (text.includes('授業') || text.includes('スケジュール')) {
      replyText = '授業のご確認はシステムからご連絡いたします。お問い合わせは教室にご連絡ください。';
    } else if (text.includes('欠席') || text.includes('休む')) {
      replyText = '欠席のご連絡をありがとうございます。授業の振替については別途ご連絡いたします。';
    } else if (text === 'テスト' || text === 'test') {
      replyText = '✅ LINEシステム接続テスト成功！リマインドシステムが正常に動作しています。';
    } else {
      replyText = 'メッセージを受け取りました。お問い合わせは教室にご連絡ください。';
    }

    if (replyToken && replyText) {
      await replyMessage(replyToken, replyText, accessToken);
    }
  }

  // フォローイベント（友達追加）
  if (type === 'follow') {
    const userId = source?.userId;
    console.log(`友達追加: ${userId}`);
    if (replyToken) {
      await replyMessage(
        replyToken,
        'ご登録ありがとうございます！授業のリマインドをLINEでお届けします。\n\n📚 授業の前日と3時間前にお知らせします。',
        accessToken
      );
    }
  }
}

/**
 * LINE返信送信
 */
async function replyMessage(replyToken, text, accessToken) {
  const https = require('https');
  
  const data = JSON.stringify({
    replyToken,
    messages: [{ type: 'text', text }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.line.me',
      path: '/v2/bot/message/reply',
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
          console.error('LINE API エラー:', res.statusCode, body);
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
