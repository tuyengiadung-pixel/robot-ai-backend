// netlify/functions/assistant.mjs - Netlify Functions v2 (Zero-Cost Backend)
// Tối ưu tốc độ: Groq openai/gpt-oss-20b + Whisper STT + TTS an toàn (Gemini TTS 3.5s timeout -> fallback Google TTS)

export const config = {
  path: "/api/assistant"
};

export default async (req, context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const getEnv = (name) => (typeof Netlify !== "undefined" && Netlify.env ? Netlify.env.get(name) : undefined) || process.env[name];

  const GROQ_API_KEY = getEnv("GROQ_API_KEY");
  const GEMINI_API_KEY = getEnv("GEMINI_API_KEY");
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_KEY = getEnv("SUPABASE_ANON_KEY");
  const TELEGRAM_BOT_TOKEN = getEnv("TELEGRAM_BOT_TOKEN");
  const TELEGRAM_CHAT_ID = getEnv("TELEGRAM_CHAT_ID");

  // Phát âm thanh tiếng Việt: GET /api/assistant?tts=...
  if (req.method === "GET") {
    const reqUrl = new URL(req.url);
    const ttsText = reqUrl.searchParams.get("tts");
    const engine = reqUrl.searchParams.get("engine") || "auto";
    if (!ttsText) {
      return Response.json({ status: "ok", fastModel: "openai/gpt-oss-20b" }, { status: 200, headers: corsHeaders });
    }

    // 1. Thử giọng AI tự nhiên Gemini 3.8 Flash-Lite TTS (giới hạn 3.5s để không treo Netlify)
    if (GEMINI_API_KEY && engine !== "google") {
      try {
        const ttsRes = await fetchWithTimeout(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY.trim()
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: ttsText.slice(0, 200) }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: "Aoede" }
                  }
                }
              }
            })
          },
          3500
        );
        const ttsJson = await ttsRes.json();
        const part = ttsJson?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const b64 = part?.data;
        const mime = (part?.mimeType || "").toLowerCase();
        // Chỉ trả về nếu đúng chuẩn WAV hoặc MP3 mà trình duyệt iOS Safari phát được
        if (b64 && (mime.includes("wav") || mime.includes("mpeg") || mime.includes("mp3"))) {
          const bin = Buffer.from(b64, "base64");
          if (bin.length > 1000) {
            return new Response(bin, {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": mime,
                "Cache-Control": "public, max-age=3600"
              }
            });
          }
        }
      } catch (e) {
        // Bỏ qua nếu quá 3.5s hoặc lỗi, chuyển ngay sang Google Translate TTS bên dưới
      }
    }

    // 2. Dự phòng chắc chắn 100%: Google Translate TTS (MP3 chuẩn mọi trình duyệt)
    try {
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=${encodeURIComponent(ttsText.slice(0, 200))}`;
      const audioRes = await fetchWithTimeout(ttsUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, 3500);
      const buf = await audioRes.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=3600"
        }
      });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
    }
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: corsHeaders });
  }

  // Chuyển giọng nói thành văn bản (STT) qua Groq Whisper: POST /api/assistant?stt=1
  const reqUrl = new URL(req.url);
  if (reqUrl.searchParams.get("stt") === "1") {
    if (!GROQ_API_KEY) {
      return Response.json({ error: "Chưa cấu hình GROQ_API_KEY để nhận diện giọng nói." }, { status: 400, headers: corsHeaders });
    }
    try {
      const incomingForm = await req.formData();
      const audioFile = incomingForm.get("file");
      if (!audioFile) {
        return Response.json({ error: "Không nhận được file âm thanh từ micro." }, { status: 400, headers: corsHeaders });
      }
      const groqForm = new FormData();
      groqForm.append("file", audioFile, audioFile.name || "voice.mp4");
      groqForm.append("model", "whisper-large-v3-turbo");
      groqForm.append("language", "vi");

      const sttRes = await fetchWithTimeout("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${GROQ_API_KEY.trim()}` },
        body: groqForm
      }, 7500);
      const sttData = await sttRes.json();
      if (sttData.error) {
        return Response.json({ error: sttData.error.message }, { status: 500, headers: corsHeaders });
      }
      return Response.json({ text: (sttData.text || "").trim() }, { status: 200, headers: corsHeaders });
    } catch (e) {
      return Response.json({ error: "Lỗi nhận diện giọng nói: " + e.message }, { status: 500, headers: corsHeaders });
    }
  }

  const askAI = (text) => callAI({ groqKey: GROQ_API_KEY, geminiKey: GEMINI_API_KEY, text });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      prompt,
      mode = "car",
      location = "Dau Tieng, Binh Duong",
      drivingMinutes = 0
    } = body;

    if (!prompt) {
      return Response.json({ error: "Thiếu nội dung câu lệnh (prompt)" }, { status: 400, headers: corsHeaders });
    }

    const lower = prompt.toLowerCase();
    let breakPrefix = "";
    if (mode === "car" && Number(drivingMinutes) >= 105) {
      breakPrefix = "Lưu ý bạn đã lái liên tục gần 2 tiếng rồi, nhớ tấp vào nghỉ 5 phút uống nước nhé. ";
    }

    const jsonReply = (payload, status = 200) => Response.json(payload, { status, headers: corsHeaders });

    // 1. ĐIỂM TIN TỨC TRONG NGÀY (RSS VnExpress + dự phòng Tuổi Trẻ)
    if (lower.includes("tin tức") || lower.includes("điểm tin") || lower.includes("báo mới")) {
      const titles = await fetchLatestNewsTitles();
      if (titles.length === 0) {
        return jsonReply({ intent: "news", reply: "Hiện không lấy được nguồn tin RSS từ báo điện tử, bạn thử lại sau ít phút nhé.", audioAction: "speak" });
      }
      const summaryPrompt = `Bạn là trợ lý AI trên xe hơi. Hãy đọc tóm tắt tự nhiên, ngắn gọn bằng tiếng Việt 5 tin tức nổi bật sau đây trong khoảng 3 đến 4 câu để tài xế nghe nhanh (không dùng dấu sao hay ký hiệu markdown):\n${titles.join("\n")}`;
      const reply = breakPrefix + await askAI(summaryPrompt);
      logChat(SUPABASE_URL, SUPABASE_KEY, prompt, reply, "news", mode).catch(() => {});
      return jsonReply({ intent: "news", reply, audioAction: "speak" });
    }

    // 2. PHÁT NHẠC KÉP (OFFLINE MICROSD / ĐÁM MÂY)
    if (lower.includes("mở nhạc") || lower.includes("phát nhạc") || lower.includes("nghe nhạc") || lower.includes("mở bài")) {
      if (lower.includes("thẻ nhớ") || lower.includes("offline") || lower.includes("mở bài")) {
        return jsonReply({
          intent: "music_offline",
          songQuery: prompt.replace(/mở bài|mở nhạc|phát nhạc|thẻ nhớ|offline/gi, "").trim(),
          reply: breakPrefix + "Đang tìm và phát nhạc offline từ thẻ nhớ của bạn.",
          audioAction: "play_sd"
        });
      }
      const tracks = await sbSelect(SUPABASE_URL, SUPABASE_KEY, "cloud_playlist?select=*&limit=1");
      if (tracks.length > 0) {
        return jsonReply({
          intent: "music_cloud",
          reply: breakPrefix + `Đang phát bài ${tracks[0].title} từ kho nhạc đám mây.`,
          streamUrl: tracks[0].stream_url,
          audioAction: "play_url"
        });
      }
      return jsonReply({
        intent: "music_offline",
        reply: breakPrefix + "Chưa có nhạc trên mây, mình chuyển sang phát nhạc từ thẻ nhớ nhé.",
        audioAction: "play_sd"
      });
    }

    // 3. GỬI TIN NHẮN TELEGRAM RẢNH TAY (Voice-to-Telegram)
    if (lower.includes("nhắn telegram") || lower.includes("gửi telegram") || lower.startsWith("nhắn cho")) {
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return jsonReply({
          intent: "telegram_send",
          reply: "Chức năng gửi Telegram chưa cấu hình TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trên Netlify.",
          audioAction: "speak"
        });
      }
      const msgText = await askAI(`Chuyển câu lệnh giọng nói sau thành 1 tin nhắn ngắn gọn, lịch sự để gửi qua Telegram (chỉ trả về nội dung tin nhắn): "${prompt}"`);
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `🚗 [Robot AI]: ${msgText}` })
      });
      const reply = `Đã gửi tin nhắn Telegram: ${msgText}`;
      logChat(SUPABASE_URL, SUPABASE_KEY, prompt, reply, "telegram_send", mode).catch(() => {});
      return jsonReply({ intent: "telegram_send", reply, audioAction: "speak", ledColor: "green" });
    }

    // 4. ĐỌC THÔNG BÁO CÔNG VIỆC (Make.com / Telegram / Gmail)
    if (lower.includes("đọc thông báo") || lower.includes("có tin nhắn") || lower.includes("kiểm tra việc")) {
      const notifs = await sbSelect(SUPABASE_URL, SUPABASE_KEY, "notifications_queue?is_read=eq.false&order=created_at.desc&limit=5");
      if (notifs.length === 0) {
        return jsonReply({ intent: "notifications", reply: "Hiện không có thông báo công việc mới nào.", audioAction: "speak" });
      }
      const listText = notifs.map((n, i) => `${i + 1}. Từ ${n.source} (${n.sender || "Hệ thống"}): ${n.summary}`).join("\n");
      const reply = await askAI(`Tóm tắt ngắn gọn các thông báo sau để đọc thành tiếng (không dùng markdown):\n${listText}`);
      return jsonReply({ intent: "notifications", reply, audioAction: "speak", ledColor: "blue" });
    }

    // 5. GHI CHÚ NHANH & VOICE-TO-TASK
    if (lower.startsWith("ghi chú") || lower.startsWith("nhắc tôi") || lower.includes("lưu lại") || lower.includes("việc cần làm") || lower.includes("thêm task")) {
      const isTask = lower.includes("việc") || lower.includes("task") || lower.includes("nhắc tôi");
      if (isTask) {
        const cleanTask = await askAI(`Trích xuất tiêu đề việc cần làm ngắn gọn từ câu sau (chỉ trả về tiêu đề): "${prompt}"`);
        await sbInsert(SUPABASE_URL, SUPABASE_KEY, "tasks", { title: cleanTask.trim(), source: "voice", priority: "normal" });
        return jsonReply({ intent: "voice_to_task", reply: `Đã thêm việc cần làm: ${cleanTask.trim()}`, audioAction: "speak" });
      } else {
        await sbInsert(SUPABASE_URL, SUPABASE_KEY, "voice_notes", { content: prompt, category: mode });
        return jsonReply({ intent: "note", reply: "Đã lưu ghi chú nhanh của bạn.", audioAction: "speak" });
      }
    }

    // 6. CẢNH BÁO THỜI TIẾT THEO TUYẾN ĐƯỜNG
    if (lower.includes("thời tiết") || lower.includes("trời mưa") || lower.includes("tuyến đường")) {
      const targetCity = lower.includes("sài gòn") || lower.includes("hồ chí minh") ? "Ho Chi Minh City" : location;
      const wRes = await fetchWithTimeout(`https://wttr.in/${encodeURIComponent(targetCity)}?format=j1`, {}, 4000);
      const wJson = await wRes.json();
      const cur = wJson?.current_condition?.[0];
      const weatherInfo = cur ? `Nhiệt độ ${cur.temp_C}°C, độ ẩm ${cur.humidity}%, gió ${cur.windspeedKmph} km/h, tình trạng: ${cur.weatherDesc?.[0]?.value}` : "Không lấy được dữ liệu chi tiết";
      const reply = await askAI(`Dựa trên dữ liệu thời tiết tại ${targetCity}: ${weatherInfo}. Hãy cảnh báo ngắn gọn cho tài xế trong 2 câu tiếng Việt (không markdown).`);
      return jsonReply({ intent: "weather", reply: breakPrefix + reply, audioAction: "speak" });
    }

    // 7. CHẾ ĐỘ "TÀI XẾ TỈNH TÁO" CHỐNG BUỒN NGỦ
    if (lower.includes("buồn ngủ") || lower.includes("tỉnh táo") || lower.includes("lái xe đêm")) {
      const reply = await askAI("Tài xế đang hơi buồn ngủ. Hãy nói 1 câu khích lệ tỉnh táo thật ngắn bằng tiếng Việt, rồi đố vui 1 câu đố mẹo hoặc hỏi 1 câu tương tác nhanh để tài xế trả lời (không dùng markdown).");
      return jsonReply({ intent: "awake_mode", reply, audioAction: "speak", ledColor: "red" });
    }

    // 8. HỎI ĐÁP LUẬT GIAO THÔNG & XỬ LÝ LỖI XE TỨC THÌ
    if (lower.includes("luật") || lower.includes("phạt") || lower.includes("biển báo") || lower.includes("đèn báo") || lower.includes("check engine") || lower.includes("lỗi xe")) {
      const reply = await askAI(`Bạn là chuyên gia kỹ thuật ô tô và Luật giao thông đường bộ Việt Nam. Hãy trả lời câu hỏi sau bằng tiếng Việt thật ngắn gọn trong 2 đến 3 câu để tài xế nghe nhanh (không markdown):\n${prompt}`);
      return jsonReply({ intent: "traffic_auto", reply: breakPrefix + reply, audioAction: "speak" });
    }

    // 9. LUYỆN PHẢN XẠ GIAO TIẾP NGOẠI NGỮ 2 CHIỀU
    if (lower.includes("tiếng anh") || lower.includes("ngoại ngữ") || lower.includes("luyện nói")) {
      const reply = await askAI(`Bạn là giáo viên luyện phản xạ tiếng Anh trên xe hơi. Hãy nói 1 câu tiếng Anh tự nhiên liên quan đến chủ đề người dùng nêu, kèm giải thích tiếng Việt ngắn và gợi ý để tài xế nói lại (không markdown):\n${prompt}`);
      return jsonReply({ intent: "language_practice", reply, audioAction: "speak" });
    }

    // 10. ĐỒNG HỒ POMODORO & TẬP TRUNG
    if (lower.includes("pomodoro") || lower.includes("tập trung") || lower.includes("đếm giờ")) {
      return jsonReply({
        intent: "pomodoro",
        durationMinutes: 25,
        reply: "Đã bật đồng hồ Pomodoro 25 phút tập trung. Chúc bạn làm việc hiệu quả!",
        audioAction: "pomodoro_start",
        ledColor: "purple"
      });
    }

    // 11. ĐỌC SÁCH NÓI & TÀI LIỆU CÁ NHÂN
    if (lower.includes("đọc sách") || lower.includes("sách nói") || lower.includes("tài liệu")) {
      const books = await sbSelect(SUPABASE_URL, SUPABASE_KEY, "audiobooks?select=*&limit=1");
      if (books.length > 0) {
        const b = books[0];
        if (b.audio_url) {
          return jsonReply({ intent: "audiobook", reply: `Đang phát sách nói ${b.title}, ${b.chapter}.`, streamUrl: b.audio_url, audioAction: "play_url" });
        }
        return jsonReply({ intent: "audiobook", reply: `Đọc ${b.title}, ${b.chapter}: ${b.content_text}`, audioAction: "speak" });
      }
      return jsonReply({ intent: "audiobook", reply: "Kho sách nói trên Supabase hiện chưa có dữ liệu. Bạn hãy thêm sách vào bảng audiobooks nhé.", audioAction: "speak" });
    }

    // 12. KỂ CHUYỆN / PODCAST AI ĐƯỜNG DÀI
    if (lower.includes("kể chuyện") || lower.includes("podcast")) {
      const reply = await askAI(`Hãy kể một câu chuyện ngắn hoặc làm một đoạn mini-podcast 1 phút bằng tiếng Việt thật lôi cuốn, giọng văn tự nhiên để nghe khi lái xe đường dài về yêu cầu sau (không markdown):\n${prompt}`);
      return jsonReply({ intent: "podcast", reply: breakPrefix + reply, audioAction: "speak" });
    }

    // 13. SMART CLOCK & LỊCH HẸN GOOGLE CALENDAR
    if (lower.includes("lịch hôm nay") || lower.includes("lịch họp") || lower.includes("lịch hẹn")) {
      const tasks = await sbSelect(SUPABASE_URL, SUPABASE_KEY, "tasks?status=eq.pending&order=created_at.desc&limit=5");
      if (tasks.length === 0) {
        return jsonReply({ intent: "agenda", reply: "Hôm nay bạn chưa có lịch hẹn hay việc cần làm nào đang chờ.", audioAction: "speak" });
      }
      const list = tasks.map((t, i) => `${i + 1}. ${t.title}`).join(". ");
      return jsonReply({ intent: "agenda", reply: `Danh sách việc và lịch hẹn sắp tới của bạn: ${list}.`, audioAction: "speak" });
    }

    // 14. TRÒ CHUYỆN AI THÔNG THƯỜNG
    const systemContext = mode === "car"
      ? "Bạn là trợ lý AI đồng hành trên xe hơi. Trả lời bằng tiếng Việt ngắn gọn tối đa 3 câu, tự nhiên như người nói chuyện, không dùng dấu sao hay ký hiệu markdown."
      : "Bạn là trợ lý AI trên bàn làm việc. Trả lời bằng tiếng Việt súc tích, rõ ràng, không dùng markdown.";

    const reply = breakPrefix + await askAI(`${systemContext}\nNgười dùng: ${prompt}`);
    logChat(SUPABASE_URL, SUPABASE_KEY, prompt, reply, "chat", mode).catch(() => {});
    return jsonReply({ intent: "chat", reply, audioAction: "speak" });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
  }
};

async function fetchLatestNewsTitles() {
  const feeds = [
    "https://vnexpress.net/rss/tin-moi-nhat.rss",
    "https://tuoitre.vn/rss/tin-moi-nhat.rss"
  ];
  for (const feedUrl of feeds) {
    try {
      const res = await fetchWithTimeout(feedUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      }, 3500);
      if (!res.ok) continue;
      const xml = await res.text();
      const matches = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)];
      const titles = matches.slice(0, 5).map((m, i) => `${i + 1}. ${m[1].trim()}`);
      if (titles.length > 0) return titles;
    } catch (e) {}
  }
  return [];
}

function buildSbHeaders(key, extra = {}) {
  const headers = { apikey: key, ...extra };
  if (key && key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function sbSelect(url, key, path) {
  if (!url || !key) return [];
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: buildSbHeaders(key)
  });
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function sbInsert(url, key, table, payload) {
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: buildSbHeaders(key, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
}

async function logChat(url, key, user_query, ai_reply, intent, device_mode) {
  await sbInsert(url, key, "assistant_logs", { user_query, ai_reply, intent, device_mode });
}

async function fetchWithTimeout(url, options, ms = 6000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function callAI({ groqKey, geminiKey, text }) {
  if (groqKey) {
    const groqModels = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
    for (const model of groqModels) {
      try {
        const resp = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${groqKey.trim()}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: text }],
            temperature: 0.6,
            max_tokens: 350
          })
        }, 5500);
        const data = await resp.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (reply) return reply.trim();
        if (data?.error && resp.status !== 429 && resp.status !== 503) {
          return `Lỗi Groq (${resp.status}): ${data.error.message}`;
        }
      } catch (e) {}
    }
  }

  if (geminiKey) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
    try {
      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey.trim()
        },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] })
      }, 6000);
      const data = await resp.json();
      if (data.error) return `Lỗi Gemini (${data.error.code}): ${data.error.message}`;
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) return reply;
    } catch (e) {
      return "Máy chủ AI đang phản hồi chậm, bạn bấm thử lại nhé.";
    }
  }

  return "Chưa cấu hình GROQ_API_KEY hoặc GEMINI_API_KEY trên Netlify.";
}