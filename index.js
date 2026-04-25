// index.js
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

// ตั้งค่าจาก LINE Developers Console
const config = {
  channelAccessToken: '4kG+nfJK6kPwI9yQDlBFa/7BrzYCWh1mmCFkFw9vePVaHeHIRPNIPsFPy+Ulpa9DCzA1nAzJsEDy93t1nmLz45f0OirJCYjEMyiLsWBE09G1T9bWjCkhQqyiKF+rZPpzU56lXo1RAKMoETJqPejdlgdB04t89/1O/w1cDnyilFU=',
  channelSecret: '65835210ae84b3ee5f58ad520f91195a'
};

// สร้าง Client สำหรับ Messaging API (เวอร์ชันล่าสุด v9+)
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

// ใช้ Middleware ของ LINE เพื่อตรวจสอบ Signature
app.use('/webhook', line.middleware(config));

// รับ webhook จาก LINE
app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Error in webhook handler:', err);
      res.status(500).end();
    });
});

// ฟังก์ชัน handleEvent สำหรับจัดการ Event ต่างๆ
async function handleEvent(event) {
  // ตรวจสอบว่าเป็นข้อความ (Message) และเป็นข้อความตัวอักษร (Text) หรือไม่
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // ส่งข้อความตอบกลับโดยใช้ MessagingApiClient.replyMessage
  // โครงสร้างใหม่ต้องส่งเป็น Object ที่มี replyToken และ messages (Array)
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'text',
      text: `คุณพิมพ์ว่า: ${event.message.text}`
    }]
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
