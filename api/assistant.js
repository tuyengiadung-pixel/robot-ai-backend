// api/assistant.js - Vercel Serverless Function (Zero-Cost Backend v2)
// Hỗ trợ: 4 tính năng cốt lõi (Phần A) + 12 tính năng mở rộng (Phần B)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const {
    prompt,
    mode = 'car',
    location = 'Dau Tieng, Binh Duong',
    drivingMinutes = 0
  } = req.body || {};

  if (!prompt) return res.status(400).json({ error: 'Thiếu nội dung câu lệnh (prompt)' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  try {
    const lower = prompt.toLowerCase();
    let breakPrefix = '';
    if (mode === 'car' && Number(drivingMinutes) >= 105) {
      breakPrefix = 'Lưu ý bạn đã lái liên tục gần 2 tiếng rồi, nhớ tấp vào nghỉ 5 phút uống nước nhé. ';
    }

    // 1. ĐIỂM TIN TỨC TRONG NGÀY (RSS VnExpress)
    if (lower.includes('tin tức') || lower.includes('điểm tin') || lower.includes('báo mới')) {
      const rssRes = await fetch('https://vnexpress.net/rss/tin-moi-nhat.rss');
      const rssXml = await rssRes.text();
      const titles = [...rssXml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
        .slice(1, 6)
        .map((m, i) => `${i + 1}. ${m[1]}`);

      const summaryPrompt = `Bạn là trợ lý AI trên xe hơi. Hãy đọc tóm tắt ngắn gọn, tự nhiên bằng tiếng Việt 5 tin tức nổi bật sau đây để tài xế dễ nghe trong 30 giây (không dùng markdown):\n${titles.join('\n')}`;
      const reply = breakPrefix + await callGemini(GEMINI_API_KEY, summaryPrompt);
      await logChat(SUPABASE_URL, SUPABASE_KEY, prompt, reply, 'news', mode);
      return res.status(200).json({ intent: 'news', reply, audioAction: 'speak' });
    }

    // 2. PHÁT NHẠC KÉP (OFFLINE MICROSD / ĐÁM MÂY)
    if (lower.includes('mở nhạc') || lower.includes('phát nhạc') || lower.includes('nghe nhạc') || lower.includes('mở bài')) {
      if (lower.includes('thẻ nhớ') || lower.includes('offline') || lower.includes('mở bài')) {
        return res.status(200).json({
          intent: 'music_offline',
          songQuery: prompt.replace(/mở bài|mở nhạc|phát nhạc|thẻ nhớ|offline/gi, '').trim(),
          reply: breakPrefix + 'Đang tìm và phát nhạc offline từ thẻ nhớ của bạn.',
          audioAction: 'play_sd'
        });
      }
      const tracks = await sbSelect(SUPABASE_URL, SUPABASE_KEY, 'cloud_playlist?select=*&limit=1');
      if (tracks.length > 0) {
        return res.status(200).json({
          intent: 'music_cloud',
          reply: breakPrefix + `Đang phát bài ${tracks[0].title} từ kho nhạc đám mây.`,
          streamUrl: tracks[0].stream_url,
          audioAction: 'play_url'
        });
      }
      return res.status(200).json({
        intent: 'music_offline',
        reply: breakPrefix + 'Chưa có nhạc trên mây, mình chuyển sang phát nhạc từ thẻ nhớ nhé.',
        audioAction: 'play_sd'
      });
    }

    // 3. GỬI TIN NHẮN TELEGRAM RẢNH TAY (Voice-to-Telegram)
    if (lower.includes('nhắn telegram') || lower.includes('gửi telegram') || lower.startsWith('nhắn cho')) {
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.status(200).json({
          intent: 'telegram_send',
          reply: 'Chức năng gửi Telegram chưa cấu hình TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trên Vercel.',
          audioAction: 'speak'
        });
      }
      const msgText = await callGemini(GEMINI_API_KEY, `Chuyển câu lệnh giọng nói sau thành 1 tin nhắn ngắn gọn, lịch sự để gửi qua Telegram (chỉ trả về nội dung tin nhắn): "${prompt}"`);
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `🚗 [Robot AI]: ${msgText}` })
      });
      const reply = `Đã gửi tin nhắn Telegram: ${msgText}`;
      await logChat(SUPABASE_URL, SUPABASE_KEY, prompt, reply, 'telegram_send', mode);
      return res.status(200).json({ intent: 'telegram_send', reply, audioAction: 'speak', ledColor: 'green' });
    }

    // 4. ĐỌC THÔNG BÁO CÔNG VIỆC (Make.com / Telegram / Gmail)
    if (lower.includes('đọc thông báo') || lower.includes('có tin nhắn') || lower.includes('kiểm tra việc')) {
      const notifs = await sbSelect(SUPABASE_URL, SUPABASE_KEY, 'notifications_queue?is_read=eq.false&order=created_at.desc&limit=5');
      if (notifs.length === 0) {
        return res.status(200).json({ intent: 'notifications', reply: 'Hiện không có thông báo công việc mới nào.', audioAction: 'speak' });
      }
      const listText = notifs.map((n, i) => `${i + 1}. Từ ${n.source} (${n.sender || 'Hệ thống'}): ${n.summary}`).join('\n');
      const reply = await callGemini(GEMINI_API_KEY, `Tóm tắt ngắn gọn các thông báo sau để đọc thành tiếng (không dùng markdown):\n${listText}`);
      return res.status(200).json({ intent: 'notifications', reply, audioAction: 'speak', ledColor: 'blue' });
    }

    // 5. GHI CHÚ NHANH & VOICE-TO-TASK
    if (lower.startsWith('ghi chú') || lower.startsWith('nhắc tôi') || lower.includes('lưu lại') || lower.includes('việc cần làm') || lower.includes('thêm task')) {
      const isTask = lower.includes('việc') || lower.includes('task') || lower.includes('nhắc tôi');
      if (isTask) {
        const cleanTask = await callGemini(GEMINI_API_KEY, `Trích xuất tiêu đề việc cần làm ngắn gọn từ câu sau (chỉ trả về tiêu đề): "${prompt}"`);
        await sbInsert(SUPABASE_URL, SUPABASE_KEY, 'tasks', { title: cleanTask.trim(), source: 'voice', priority: 'normal' });
        const reply = `Đã thêm việc cần làm: ${cleanTask.trim()}`;
        return res.status(200).json({ intent: 'voice_to_task', reply, audioAction: 'speak' });
      } else {
        await sbInsert(SUPABASE_URL, SUPABASE_KEY, 'voice_notes', { content: prompt, category: mode });
        return res.status(200).json({ intent: 'note', reply: 'Đã lưu ghi chú nhanh của bạn.', audioAction: 'speak' });
      }
    }

    // 6. CẢNH BÁO THỜI TIẾT THEO TUYẾN ĐƯỜNG
    if (lower.includes('thời tiết') || lower.includes('trời mưa') || lower.includes('tuyến đường')) {
      const targetCity = lower.includes('sài gòn') || lower.includes('hồ chí minh') ? 'Ho Chi Minh City' : location;
      const wRes = await fetch(`https://wttr.in/${encodeURIComponent(targetCity)}?format=j1`);
      const wJson = await wRes.json();
      const cur = wJson?.current_condition?.[0];
      const weatherInfo = cur ? `Nhiệt độ ${cur.temp_C}°C, độ ẩm ${cur.humidity}%, gió ${cur.windspeedKmph} km/h, tình trạng: ${cur.weatherDesc?.[0]?.value}` : 'Không lấy được dữ liệu chi tiết';
      const reply = await callGemini(GEMINI_API_KEY, `Dựa trên dữ liệu thời tiết tại ${targetCity}: ${weatherInfo}. Hãy cảnh báo ngắn gọn cho tài xế trong 2 câu (không markdown).`);
      return res.status(200).json({ intent: 'weather', reply: breakPrefix + reply, audioAction: 'speak' });
    }

    // 7. CHẾ ĐỘ "TÀI XẾ TỈNH TÁO" CHỐNG BUỒN NGỦ
    if (lower.includes('buồn ngủ') || lower.includes('tỉnh táo') || lower.includes('lái xe đêm')) {
      const reply = await callGemini(GEMINI_API_KEY, 'Tài xế đang hơi buồn ngủ. Hãy nói 1 câu khích lệ tỉnh táo thật ngắn, rồi đố vui 1 câu đố mẹo hoặc hỏi 1 câu tương tác nhanh để tài xế trả lời (không dùng markdown).');
      return res.status(200).json({ intent: 'awake_mode', reply, audioAction: 'speak', ledColor: 'red' });
    }

    // 8. HỎI ĐÁP LUẬT GIAO THÔNG & XỬ LÝ LỖI XE TỨC THÌ
    if (lower.includes('luật') || lower.includes('phạt') || lower.includes('biển báo') || lower.includes('đèn báo') || lower.includes('check engine') || lower.includes('lỗi xe')) {
      const reply = await callGemini(GEMINI_API_KEY, `Bạn là chuyên gia kỹ thuật ô tô và Luật giao thông đường bộ Việt Nam. Hãy trả lời câu hỏi sau thật ngắn gọn, chuẩn xác để tài xế nghe trong 15 giây (không markdown):\n${prompt}`);
      return res.status(200).json({ intent: 'traffic_auto', reply: breakPrefix + reply, audioAction: 'speak' });
    }

    // 9. LUYỆN PHẢN XẠ GIAO TIẾP NGOẠI NGỮ 2 CHIỀU
    if (lower.includes('tiếng anh') || lower.includes('ngoại ngữ') || lower.includes('luyện nói')) {
      const reply = await callGemini(GEMINI_API_KEY, `Bạn là giáo viên luyện phản xạ tiếng Anh trên xe hơi. Hãy nói 1 câu tiếng Anh tự nhiên liên quan đến chủ đề người dùng nêu, kèm giải thích tiếng Việt ngắn và gợi ý để tài xế nói lại (không markdown):\n${prompt}`);
      return res.status(200).json({ intent: 'language_practice', reply, audioAction: 'speak' });
    }

    // 10. ĐỒNG HỒ POMODORO & TẬP TRUNG (Bàn làm việc)
    if (lower.includes('pomodoro') || lower.includes('tập trung') || lower.includes('đếm giờ')) {
      return res.status(200).json({
        intent: 'pomodoro',
        durationMinutes: 25,
        reply: 'Đã bật đồng hồ Pomodoro 25 phút tập trung. Chúc bạn làm việc hiệu quả!',
        audioAction: 'pomodoro_start',
        ledColor: 'purple'
      });
    }

    // 11. ĐỌC SÁCH NÓI & TÀI LIỆU CÁ NHÂN
    if (lower.includes('đọc sách') || lower.includes('sách nói') || lower.includes('tài liệu')) {
      const books = await sbSelect(SUPABASE_URL, SUPABASE_KEY, 'audiobooks?select=*&limit=1');
      if (books.length > 0) {
        const b = books[0];
        if (b.audio_url) {
          return res.status(200).json({ intent: 'audiobook', reply: `Đang phát sách nói ${b.title}, ${b.chapter}.`, streamUrl: b.audio_url, audioAction: 'play_url' });
        }
        return res.status(200).json({ intent: 'audiobook', reply: `Đọc ${b.title}, ${b.chapter}: ${b.content_text}`, audioAction: 'speak' });
      }
      return res.status(200).json({ intent: 'audiobook', reply: 'Kho sách nói trên Supabase hiện chưa có dữ liệu. Bạn hãy thêm sách vào bảng audiobooks nhé.', audioAction: 'speak' });
    }

    // 12. KỂ CHUYỆN / PODCAST AI ĐƯỜNG DÀI
    if (lower.includes('kể chuyện') || lower.includes('podcast')) {
      const reply = await callGemini(GEMINI_API_KEY, `Hãy kể một câu chuyện hoặc làm một đoạn mini-podcast 2 phút thật lôi cuốn, giọng văn tự nhiên để nghe khi lái xe đường dài về yêu cầu sau (không markdown):\n${prompt}`);
      return res.status(200).json({ intent: 'podcast', reply: breakPrefix + reply, audioAction: 'speak' });
    }

    // 13. SMART CLOCK & LỊCH HẸN GOOGLE CALENDAR
    if (lower.includes('lịch hôm nay') || lower.includes('lịch họp') || lower.includes('lịch hẹn')) {
      const tasks = await sbSelect(SUPABASE_URL, SUPABASE_KEY, 'tasks?status=eq.pending&order=created_at.desc&limit=5');
      if (tasks.length === 0) {
        return res.status(200).json({ intent: 'agenda', reply: 'Hôm nay bạn chưa có lịch hẹn hay việc cần làm nào đang chờ.', audioAction: 'speak' });
      }
      const list = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('. ');
      return res.status(200).json({ intent: 'agenda', reply: `Danh sách việc và lịch hẹn sắp tới của bạn: ${list}.`, audioAction: 'speak' });
    }

    // 14. TRÒ CHUYỆN AI THÔNG THƯỜNG
    const systemContext = mode === 'car'
      ? 'Bạn là trợ lý AI đồng hành trên xe hơi. Trả lời ngắn gọn, súc tích, thân thiện, không dùng dấu sao hay ký hiệu markdown để đọc thành tiếng tự nhiên.'
      : 'Bạn là trợ lý AI trên bàn làm việc. Trả lời thông minh, rõ ràng, không dùng markdown để đọc thành tiếng tự nhiên.';

    const reply = breakPrefix + await callGemini(GEMINI_API_KEY, `${systemContext}\nNgười dùng: ${prompt}`);
    await logChat(SUPABASE_URL, SUPABASE_KEY, prompt, reply, 'chat', mode);
    return res.status(200).json({ intent: 'chat', reply, audioAction: 'speak' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function sbSelect(url, key, path) {
  if (!url || !key) return [];
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function sbInsert(url, key, table, payload) {
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function logChat(url, key, user_query, ai_reply, intent, device_mode) {
  await sbInsert(url, key, 'assistant_logs', { user_query, ai_reply, intent, device_mode });
}

async function callGemini(apiKey, text) {
  if (!apiKey) return 'Chưa cấu hình GEMINI_API_KEY trên máy chủ Vercel.';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] })
  });
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Xin lỗi, tôi chưa nghe rõ.';
}