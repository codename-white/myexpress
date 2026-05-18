// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

// ตั้งค่าจาก LINE Developers Console
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || ""
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

app.get('/', (req, res) => {
  res.send('hello world, suphanut');
});


async function handleImageMessage(event) {
  const messageId = event.message.id;

  try {
    // ดึงไฟล์จาก LINE
    const stream = await client.getMessageContent(messageId);

    // แปลง stream → buffer
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // อัพโหลดเข้า Supabase Storage
    const fileName = `line_images/${messageId}.jpg`;
    const { data, error } = await supabase.storage
      .from("uploads") // ชื่อ bucket
      .upload(fileName, buffer, {
        contentType: "image/jpeg",
        upsert: true, // ถ้ามีไฟล์ชื่อซ้ำ จะเขียนทับ
      });

    if (error) {
      console.error("❌ Upload error:", error);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: 'เกิดข้อผิดพลาดในการอัปโหลดรูปภาพลง Storage'
        }]
      });
    }

    // ให้ Gemini วิเคราะห์รูปภาพว่าเป็นสัตว์ชนิดอะไร
    let aiAnswer = "";
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-lite',
        contents: [
          {
            inlineData: {
              data: buffer.toString("base64"),
              mimeType: "image/jpeg"
            }
          },
          "รูปภาพนี้คือสัตว์ชนิดอะไร ช่วยบอกสั้นๆ"
        ]
      });
      aiAnswer = response.text;
    } catch (err) {
      console.error("Gemini Image Error:", err);
      aiAnswer = "ขออภัยครับ ไม่สามารถวิเคราะห์รูปภาพได้ในขณะนี้ (อาจติดปัญหา Quota)";
    }

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: 'ได้รับรูปภาพและบันทึกลง Supabase Storage เรียบร้อยแล้วครับ'
        },
        {
          type: 'text',
          text: aiAnswer
        }
      ]
    });

  } catch (error) {
    console.error("Image processing error:", error);
  }
}

// 4. ฟังก์ชันหลักในการจัดการ Event และบันทึกข้อมูล
async function handleEvent(event) {
  // รองรับเฉพาะ Event ประเภทข้อความ (Message Event) เท่านั้น
  if (event.type !== 'message') {
    return null;
  }

  const userId = event.source.userId || 'unknown';
  const replyToken = event.replyToken || '';
 
  // ดึงข้อมูลพื้นฐานจาก Message Object ของ LINE
  const messageId = event.message.id;
  const messageType = event.message.type; // text, image, sticker, video, etc.

  // ถ้าเป็นรูปภาพ ให้ส่งไปทำงานที่ฟังก์ชัน handleImageMessage ทันที (อ้างอิงตามสไลด์)
  if (messageType === 'image') {
    return handleImageMessage(event);
  }
 
  let content = null;
  let botReplyText = '';

  // ตรวจสอบเงื่อนไขตามประเภทข้อความ
  if (messageType === 'text') {
    content = event.message.text;
    
    // เรียกใช้ Gemini สร้างคำตอบที่สร้างสรรค์และสั้น
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-lite',
        contents: content,
        config: {
          systemInstruction: "คุณคือบอทผู้ช่วยใน LINE ให้ตอบคำถามสั้นๆ กระชับ ได้ใจความ และมีความสร้างสรรค์",
        }
      });
      botReplyText = response.text;
    } catch (err) {
      console.error('Gemini Error:', err);
      botReplyText = "ขออภัยครับ ระบบ AI เกิดข้อขัดข้องชั่วคราว";
    }
  } else {
    // หากเป็นประเภทอื่น (ที่ไม่ใช่รูปและไม่ใช่ text) เช่น sticker, video
    content = `[Received ${messageType} message]`;
    botReplyText = `ได้รับข้อความประเภท ${messageType} แล้วครับ`;
  }

  try {
    // บันทึกข้อมูลลงตาราง messages ใน Supabase (บันทึกคู่ทั้งคำถามและคำตอบที่เตรียมไว้)
    const { error } = await supabase
      .from('messages')
      .insert([
        {
          user_id: userId,
          message_id: messageId,
          type: messageType,
          content: content,
          reply_token: replyToken,
          reply_content: botReplyText
        }
      ]);

    if (error) {
      console.error('Supabase Insert Error:', error.message);
    }

    // ตอบกลับข้อความไปยังผู้ใช้ใน LINE
    return await client.replyMessage({
      replyToken: replyToken,
      messages: [
        {
          type: 'text',
          text: botReplyText,
        },
      ],
    });

  } catch (error) {
    console.error('เกิดข้อผิดพลาดในการประมวลผลระบบ:', error);
  }
}

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
