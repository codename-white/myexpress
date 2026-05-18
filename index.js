// --- 1. นำเข้าไลบรารีที่จำเป็น ---
import * as line from '@line/bot-sdk';
import express from 'express';
import * as dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

// --- 2. ตั้งค่าระบบ (Express, Supabase, Gemini, LINE) ---
const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  // process.env.SUPABASE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = line.LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// --- 3. สร้าง Webhook รอรับข้อความจาก LINE ---
app.post('/callback', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// event handler
// function handleEvent(event) {
//   if (event.type !== 'message' || event.message.type !== 'text') {
//     // ignore non-text-message event
//     return Promise.resolve(null);
//   }

//   // create an echoing text message
//   const echo = { type: 'text', text: event.message.text };

//   // use reply API
//   return client.replyMessage({
//     replyToken: event.replyToken,
//     messages: [echo],
//   });
// }

// --- 4. ฟังก์ชันจัดการเมื่อมีคนส่งข้อความมา ---
async function handleEvent(event) {

  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event);
  }

  if (event.type !== 'message') return null;

  const userId = event.source.userId || 'unknown';
  const replyToken = event.replyToken || '';
  const messageId = event.message.id;
  const messageType = event.message.type;

  let content = null;
  let botReplyText = '';

  if (event.message.type === 'text') {
    content = event.message.text;
  } else {
    content = `[Received ${messageType} message]`;
    botReplyText = `ได้รับข้อความประเภท ${messageType} แล้วครับ`;
  }

  try {
    // 4.1 ให้ Gemini ช่วยคิดคำตอบ (ถ้าเป็นข้อความ)
    if (event.message.type === 'text') {
      const geminiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: content,
      });
      botReplyText = geminiResponse.text || 'ขออภัยครับ ระบบไม่สามารถสร้างคำตอบได้';
    }

    // 4.2 บันทึกประวัติการแชทลงฐานข้อมูล Supabase
    const { error } = await supabase
      .from('messages')
      .insert([{
        user_id: userId,
        message_id: messageId,
        type: messageType,
        content: content,
        reply_token: replyToken,
        reply_content: botReplyText
      }]);

    if (error) console.error('Supabase Insert Error:', error.message);

    // 4.3 ส่งข้อความกลับไปหาผู้ใช้ทาง LINE
    return await client.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: botReplyText }],
    });

  } catch (error) {
    console.error('เกิดข้อผิดพลาดในการประมวลผลระบบ:', error);
  }
}

// --- 5. ฟังก์ชันจัดการเมื่อมีคนส่งรูปภาพมา ---
async function handleImage(event) {
  const messageId = event.message.id;
  const userId = event.source.userId || 'unknown';
  const replyToken = event.replyToken || '';
  
  try {
    // 5.1 ดึงไฟล์ภาพจาก LINE
    const stream = await client.getMessageContent(messageId);
    
    // 5.2 แปลง stream เป็น Buffer
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    // 5.3 อัปโหลดเข้า Supabase Storage
    const fileName = `line_images/${messageId}.jpg`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(fileName, buffer, {
        contentType: "image/jpeg",
        upsert: true,
      });

    if (uploadError) {
      console.error("❌ Upload error:", uploadError);
      return client.replyMessage({
        replyToken: replyToken,
        messages: [{ type: "text", text: "อัปโหลดรูปไป Supabase ไม่สำเร็จ" }],
      });
    }

    console.log("✅ Uploaded to Supabase:", uploadData);

    // 5.4 ให้ Gemini ช่วยจำแนกรูปภาพ
    const base64Data = buffer.toString('base64');
    const geminiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'ช่วยจำแนกและอธิบายหน่อยว่ารูปนี้คือรูปอะไร (ตอบสั้นๆ ได้ใจความ)' },
            { inlineData: { data: base64Data, mimeType: 'image/jpeg' } }
          ]
        }
      ]
    });

    const botReplyText = geminiResponse.text || 'ไม่สามารถจำแนกรูปภาพนี้ได้';

    // 5.5 บันทึกประวัติลงฐานข้อมูล Supabase
    const { error: dbError } = await supabase
      .from('messages')
      .insert([{
        user_id: userId,
        message_id: messageId,
        type: 'image',
        content: fileName, // เก็บ path ของรูปใน Storage แทน
        reply_token: replyToken,
        reply_content: botReplyText
      }]);

    if (dbError) console.error('Supabase Insert Error:', dbError.message);

    // 5.6 ตอบกลับผลการวิเคราะห์ให้ User
    return await client.replyMessage({
      replyToken: replyToken,
      messages: [
        { type: "text", text: "📷 ได้รับรูปแล้ว และอัปโหลดไป Supabase สำเร็จ!" },
        { type: "text", text: botReplyText }
      ],
    });

  } catch (err) {
    console.error("❌ Error in handleImage:", err);
  }
}

// เพิ่ม GET Method
app.get('/', (req, res) => {
  res.send('Suphanut Chaowanamethakul');
});

// listen on port
const port = process.env.PORT || 3004;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});

//Old version of line bot sdk: https://www.npmjs.com/package/linebot
// // index.js
// const express = require('express');
// const { middleware, messagingApi } = require('@line/bot-sdk');

// const app = express();

// // ตั้งค่าจาก LINE Developers Console
// const config = {
//   channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
//   channelSecret: process.env.LINE_CHANNEL_SECRET || ""
// };

// app.use('/webhook', middleware(config));

// // รับ webhook
// app.post('/webhook', (req, res) => {
//   Promise
//     .all(req.body.events.map(handleEvent))
//     .then(result => res.json(result));
// });

// // ตอบกลับข้อความ
// function handleEvent(event) {
//   if (event.type !== 'message' || event.message.type !== 'text') {
//     return Promise.resolve(null);
//   }

//   return client.replyMessage({
//     replyToken: event.replyToken,
//     messages: [{
//       type: 'text',
//       text: `คุณพิมพ์ว่า: ${event.message.text}`
//     }]
//   });
// }

// const client = new messagingApi.MessagingApiClient({
//   channelAccessToken: config.channelAccessToken
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server running at http://localhost:${PORT}`);
// });

// example
// const express = require('express');
// const app = express();
// const port = 3000

// // Respond with Hello World! on the homepage:
// app.get('/', function (req, res) {
//     res.send('Hello World!')
// })

// // Respond to POST request on the root route (/), the application’s home page:
// app.post('/', function (req, res) {
//     res.send('Got a POST request')
// })
// // Respond to a PUT request to the /user route:
// app.put('/user', function (req, res) {
//     res.send('Got a PUT request at /user')
// })
// // Respond to a DELETE request to the /user route:
// app.delete('/user', function (req, res) {
//     res.send('Got a DELETE request at /user')
// })


// app.listen(port, () => {
//     console.log(`Example app listening at http://localhost:${port}`)
// })