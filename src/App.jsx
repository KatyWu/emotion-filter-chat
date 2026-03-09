import { useState, useRef, useEffect } from "react";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, push, onChildAdded, onValue, set, serverTimestamp } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyAfZaYdhZg5s_axvdKeVTj-WtIM1UHzg2Y",
  authDomain: "emotion-filter-chat.firebaseapp.com",
  databaseURL: "https://emotion-filter-chat-default-rtdb.firebaseio.com",
  projectId: "emotion-filter-chat",
  storageBucket: "emotion-filter-chat.firebasestorage.app",
  messagingSenderId: "72825785445",
  appId: "1:72825785445:web:f40a8770b7bc4784a84a8c"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const seenKeys = new Set();

async function deriveKey(roomCode) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(roomCode), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("emotion-filter-salt"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encrypt(text, key) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  const buf = new Uint8Array([...iv, ...new Uint8Array(encrypted)]);
  return btoa(String.fromCharCode(...buf));
}

async function decrypt(b64, key) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const data = buf.slice(12);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(dec);
}

const CLASSIFY_PROMPT_ZH = `你是情緒過濾助手。依照以下步驟處理訊息，只輸出最終 JSON 結果，不加任何解釋。

輸出格式：
{"action":"send","text":"處理後的文字"} 或 {"action":"block"}

步驟一：判斷是否為被動攻擊
如果整句是被動攻擊（例：隨便啊你開心就好、算了你不會懂、隨便），輸出 {"action":"block"}，結束。

步驟二：處理以下所有問題（全部都要做，不能跳過）
- 包含罵人字眼或人身攻擊的句子 → 不要只刪字，要把整句改寫成描述自己感受或正向請求
- 激烈情緒字眼 → 換成第一人稱溫和表達（氣死了→我很生氣、煩死了→我很困擾）
- 負面或指責式提問 → 改成正向請求（你不能早點說嗎→下次可以提前告訴我嗎）
- 指責對方的句子 → 改成描述自己感受（你都不在乎我→我覺得我不被重視）

步驟三：保留原本的斷句和標點，原文沒有標點就不要加，不要在句尾加句號

步驟四：如果步驟二完全沒有需要改的，直接原文輸出

訊息：`;

const CLASSIFY_PROMPT_EN = `You are an emotion filter. Follow these steps and output only the final JSON result, no explanation.

Output format:
{"action":"send","text":"processed text"} or {"action":"block"}

Step 1: Check for passive aggression
If the whole message is passive-aggressive → {"action":"block"}, stop.

Step 2: Process ALL of the following (do not skip any):
- Sentences with insults or personal attacks → Rewrite the whole sentence as a feeling or positive request
- Harsh emotion words → first-person gentle expression (I'm so pissed → I'm really angry)
- Negative or accusatory questions → positive requests (why can't you tell me earlier → could you let me know earlier next time)
- Sentences blaming the other person → describe your own feelings

Step 3: Keep original punctuation and rhythm. No period at end.
Step 4: If nothing to change, output the original.

Message: `;

async function callAI(prompt) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
  const data = await res.json();
  return data.text;
}

async function processText(text, filter, srcLang, targetLang) {
  const translateTo = targetLang && targetLang !== srcLang ? targetLang : null;
  if (!filter && !translateTo) return { action: "send", text, filtered: false, translated: false };

  if (!filter && translateTo) {
    const prompt = translateTo === "en"
      ? `把以下訊息翻譯成自然口語英文，保留語氣和斷句節奏，只輸出翻譯結果。訊息：${text}`
      : `Translate the following to natural Traditional Chinese. Keep tone and rhythm. Output only the translation.\n\nMessage: ${text}`;
    const result = await callAI(prompt);
    return { action: "send", text: result.trim(), filtered: false, translated: true };
  }

  let prompt = srcLang === "zh" ? CLASSIFY_PROMPT_ZH + text : CLASSIFY_PROMPT_EN + text;
  if (translateTo) {
    const note = translateTo === "en"
      ? `\n處理完後，如果 action 是 send，把 text 翻譯成自然口語英文。`
      : `\nAfter processing, if action is send, translate the text to natural Traditional Chinese.`;
    prompt = srcLang === "zh"
      ? CLASSIFY_PROMPT_ZH.replace("訊息：", note + "\n\n訊息：") + text
      : CLASSIFY_PROMPT_EN.replace("Message: ", note + "\n\nMessage: ") + text;
  }

  const raw = (await callAI(prompt)).trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed.action === "block") return { action: "block" };
    return { action: "send", text: parsed.text, filtered: true, translated: !!translateTo };
  } catch {
    return { action: "send", text: raw, filtered: true, translated: !!translateTo };
  }
}

function Toggle({ on, onToggle, label, activeColor, disabled }) {
  return (
    <div onClick={disabled ? undefined : onToggle} style={{ display: "flex", alignItems: "center", gap: 5, cursor: disabled ? "not-allowed" : "pointer", fontSize: 11, color: disabled ? "#333" : "#666", userSelect: "none", opacity: disabled ? 0.4 : 1 }}>
      <div style={{ width: 26, height: 14, borderRadius: 7, background: on && !disabled ? activeColor : "#2a2a2a", position: "relative", transition: "background 0.2s" }}>
        <div style={{ position: "absolute", width: 10, height: 10, borderRadius: "50%", top: 2, left: on && !disabled ? 14 : 2, background: on && !disabled ? "#fff" : "#555", transition: "all 0.2s" }} />
      </div>
      {label}
    </div>
  );
}

function LangSelector({ lang, onChange }) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {["zh", "en"].map((l) => (
        <button key={l} onClick={() => onChange(l)} style={{ padding: "2px 7px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 500, background: lang === l ? "#3a3a3a" : "transparent", color: lang === l ? "#e8e8e8" : "#555", transition: "all 0.15s" }}>
          {l === "zh" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}

function JoinScreen({ onJoin }) {
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");

  const handleJoin = () => {
    if (!nickname.trim()) return setError("請輸入暱稱");
    if (!roomCode.trim()) return setError("請輸入房間碼");
    onJoin(nickname.trim(), roomCode.trim());
  };

  const inputStyle = {
    width: "100%", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 10,
    padding: "12px 14px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 14,
    outline: "none", boxSizing: "border-box"
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f0f0f", fontFamily: "'DM Sans', 'Noto Sans TC', sans-serif" }}>
      <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "#e8e8e8", marginBottom: 4 }}>情緒過濾聊天室</div>
          <div style={{ fontSize: 12, color: "#444" }}>輸入暱稱和房間碼進入聊天</div>
        </div>
        <input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="暱稱" style={inputStyle} onKeyDown={e => e.key === "Enter" && handleJoin()} />
        <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="房間碼（和對方輸入一樣的）" style={inputStyle} onKeyDown={e => e.key === "Enter" && handleJoin()} />
        {error && <div style={{ fontSize: 12, color: "#c04444" }}>{error}</div>}
        <button onClick={handleJoin} style={{ padding: "12px", borderRadius: 10, border: "none", background: "#7c6af7", color: "#fff", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
          進入聊天室
        </button>
      </div>
    </div>
  );
}

function ChatRoom({ nickname, roomCode, onLeave }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [filterOn, setFilterOn] = useState(true);
  const [translateOn, setTranslateOn] = useState(false);
  const [lang, setLang] = useState("zh");
  const [members, setMembers] = useState({});
  const msgsRef = useRef(null);
  const isSending = useRef(false);
  const cryptoKey = useRef(null);
  const joinTime = useRef(Date.now());
  const messagesDbRef = useRef(ref(db, `rooms/${roomCode}/messages`));
  const presenceDbRef = useRef(ref(db, `rooms/${roomCode}/presence/${nickname}`));
  const presenceRoomRef = useRef(ref(db, `rooms/${roomCode}/presence`));

  // 把自己的語言同步到 Firebase
  useEffect(() => {
    set(presenceDbRef.current, { lang });
  }, [lang]);

  useEffect(() => {
    deriveKey(roomCode).then(k => { cryptoKey.current = k; });

    // 監聽所有人的語言設定
    const unsubPresence = onValue(presenceRoomRef.current, (snapshot) => {
      const data = snapshot.val();
      if (data) setMembers(data);
    });

    // 監聽新訊息，只顯示進入之後的
    const unsubMessages = onChildAdded(messagesDbRef.current, async (snapshot) => {
      if (seenKeys.has(snapshot.key)) return;
      seenKeys.add(snapshot.key);

      const data = snapshot.val();
      if (!data || !cryptoKey.current) return;
      if (data.timestamp && data.timestamp < joinTime.current) return;

      try {
        const decrypted = await decrypt(data.text, cryptoKey.current);
        const filteredDecrypted = data.filteredText ? await decrypt(data.filteredText, cryptoKey.current) : null;
        setMessages(prev => {
          if (prev.find(m => m.firebaseKey === snapshot.key)) return prev;
          return [...prev, {
            id: snapshot.key, firebaseKey: snapshot.key,
            dir: data.sender === nickname ? "sent" : "received",
            sender: data.sender,
            text: data.sender === nickname ? decrypted : (filteredDecrypted || decrypted),
            filteredText: filteredDecrypted,
            filtered: data.filtered, translated: data.translated,
          }];
        });
      } catch (e) { console.error("decrypt failed", e); }
    });

    return () => {
      unsubPresence();
      unsubMessages();
    };
  }, [roomCode, nickname]);

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [messages]);

  const doSend = async () => {
    if (isSending.current || !input.trim() || !cryptoKey.current) return;
    isSending.current = true;
    const text = input.trim();
    setInput("");
    setTimeout(() => { isSending.current = false; }, 500);

    const otherLangs = Object.entries(members)
      .filter(([name]) => name !== nickname)
      .map(([, v]) => v.lang);
    const targetLang = translateOn && otherLangs.length > 0 ? otherLangs[0] : null;

    const tempId = "temp-" + Date.now();
    setMessages(prev => [...prev, { id: tempId, dir: "sent", sender: nickname, text, pending: true }]);

    try {
      const result = await processText(text, filterOn, lang, targetLang);
      if (result.action === "block") {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, blocked: true, pending: false } : m));
        isSending.current = false;
        return;
      }
      const encText = await encrypt(text, cryptoKey.current);
      const encFiltered = result.text !== text ? await encrypt(result.text, cryptoKey.current) : null;
      await push(messagesDbRef.current, {
        sender: nickname, text: encText, filteredText: encFiltered,
        filtered: result.filtered, translated: result.translated, timestamp: serverTimestamp(),
      });
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, filteredText: result.text !== text ? result.text : null, filtered: result.filtered, translated: result.translated, pending: false } : m));
    } catch (e) {
      console.error(e);
      isSending.current = false;
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  const accentColor = "#7c6af7";
  const sameLang = Object.values(members).every(m => m.lang === lang);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0f0f0f", fontFamily: "'DM Sans', 'Noto Sans TC', sans-serif" }}>
      <div style={{ padding: "12px 18px", borderBottom: "1px solid #1e1e1e", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "#e8e8e8" }}>{nickname}</div>
          <div style={{ fontSize: 11, color: "#444" }}>房間：{roomCode} · {Object.keys(members).join("、")}</div>
        </div>
        <LangSelector lang={lang} onChange={setLang} />
        <Toggle on={filterOn} onToggle={() => setFilterOn(v => !v)} label="過濾" activeColor="#b8960a" />
        <Toggle on={translateOn} onToggle={() => setTranslateOn(v => !v)} label="翻譯" activeColor="#3d7fd4" disabled={sameLang} />
        <button onClick={onLeave} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 12 }}>離開</button>
      </div>

      <div ref={msgsRef} style={{ flex: 1, overflowY: "auto", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((msg) => (
          <div key={msg.id} style={{ maxWidth: "75%", display: "flex", flexDirection: "column", gap: 3, alignSelf: msg.dir === "sent" ? "flex-end" : "flex-start", alignItems: msg.dir === "sent" ? "flex-end" : "flex-start" }}>
            {msg.dir === "received" && <div style={{ fontSize: 10, color: "#444", paddingLeft: 4 }}>{msg.sender}</div>}
            {msg.blocked ? (
              <div style={{ padding: "8px 13px", borderRadius: 14, fontSize: 13, background: "#1a1212", color: "#664444", border: "1px solid #2a1a1a" }}>🚫 訊息已攔截</div>
            ) : (
              <>
                <div style={{ padding: "9px 14px", borderRadius: 16, fontSize: 14, lineHeight: 1.5, wordBreak: "break-word", background: msg.dir === "sent" ? accentColor : "#1c1c1c", color: msg.dir === "sent" ? "#fff" : "#e0e0e0", opacity: msg.pending ? 0.6 : 1, borderBottomRightRadius: msg.dir === "sent" ? 3 : 16, borderBottomLeftRadius: msg.dir === "received" ? 3 : 16 }}>
                  {msg.text}
                </div>
                {msg.dir === "sent" && msg.filteredText && msg.filteredText !== msg.text && (
                  <div style={{ fontSize: 11, color: "#555", padding: "1px 4px" }}>對方收到：<span style={{ color: "#777" }}>{msg.filteredText}</span></div>
                )}
                {(msg.filtered || msg.translated) && (
                  <div style={{ fontSize: 10, color: "#444", padding: "1px 4px", fontFamily: "monospace" }}>
                    {[msg.filtered && "已過濾", msg.translated && "已翻譯"].filter(Boolean).join(" · ")}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div style={{ padding: "10px 14px", borderTop: "1px solid #1e1e1e", display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder={lang === "zh" ? "輸入訊息..." : "Type a message..."} rows={1}
          style={{ flex: 1, background: "#1a1a1a", border: "1px solid #252525", borderRadius: 11, padding: "9px 13px", color: "#e8e8e8", fontFamily: "inherit", fontSize: 14, resize: "none", outline: "none", maxHeight: 100, lineHeight: 1.5 }}
        />
        <button onClick={doSend} style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: accentColor, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg viewBox="0 0 24 24" width={15} height={15} fill="white"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  if (!session) return <JoinScreen onJoin={(nickname, roomCode) => setSession({ nickname, roomCode })} />;
  return <ChatRoom nickname={session.nickname} roomCode={session.roomCode} onLeave={() => setSession(null)} />;
}
