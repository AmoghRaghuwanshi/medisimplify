/**
 * MediSimplify - Backend Server
 * Now using Groq API (super fast + vision support)
 */

const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const serverless = require("serverless-http");

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";

// Groq models
const MAIN_MODEL   = process.env.GROQ_MODEL        || "llama-3.3-70b-versatile";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const CHAT_MODEL   = process.env.GROQ_CHAT_MODEL   || "llama-3.3-70b-versatile";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg","image/png","image/webp","image/gif"]);
const MAX_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname)));
// ─── UTILITY HELPERS ─────────────────────────────────────────────────────────

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function stripJsonFences(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  return rawText.trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```$/i,"").trim();
}

function tryParseJson(rawText) {
  const cleaned = stripJsonFences(rawText);
  try { return JSON.parse(cleaned); } catch (_) {}
  const fb = cleaned.indexOf("{"), lb = cleaned.lastIndexOf("}");
  if (fb !== -1 && lb > fb) { try { return JSON.parse(cleaned.slice(fb, lb+1)); } catch (_) {} }
  const fa = cleaned.indexOf("["), la = cleaned.lastIndexOf("]");
  if (fa !== -1 && la > fa) { try { return JSON.parse(cleaned.slice(fa, la+1)); } catch (_) {} }
  throw new Error("Could not parse JSON from response.");
}

/**
 * Core Groq API caller (OpenAI-compatible)
 */
async function callOpenRouter(messages, model = MAIN_MODEL, maxTokens = 1500) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing. Check your .env file.");

  const response = await fetch(GROQ_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ 
      model, 
      max_tokens: maxTokens, 
      temperature: 0.1, 
      messages 
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Groq error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from Groq.");
  return content.trim();
}
/** Build a user message, optionally with an image (vision). */
function buildUserMessage(text, imageInput = null) {
  if (!imageInput) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: `data:${imageInput.mimeType};base64,${imageInput.data}` } },
      { type: "text", text }
    ]
  };
}

function normalizeReportImage(input) {
  if (!input || typeof input !== "object") return null;
  const mimeType = safeText(input.mimeType).toLowerCase();
  const data = safeText(input.data).replace(/\s+/g,"").replace(/^data:[^,]+,/,"");
  if (!mimeType || !data) return null;
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Unsupported image type. Use JPG, PNG, or WEBP.");
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error("Invalid base64 image data.");
  if (data.length > MAX_IMAGE_BASE64_CHARS) throw new Error("Image too large. Please compress it.");
  return { mimeType, data };
}

function normalizeLanguage(language) { return language === "hi" ? "hi" : "en"; }
function containsDevanagari(text) { return /[\u0900-\u097F]/.test(safeText(text)); }

function isLikelyAiError(error) {
  const m = safeText(error?.message).toLowerCase();
  return m.includes("429") || m.includes("quota") || m.includes("rate limit") ||
         m.includes("resource_exhausted") || m.includes("too many requests") ||
         m.includes("503") || m.includes("overloaded") || m.includes("not found") || m.includes("404");
}

function parseNumber(text) {
  const match = safeText(text).replace(/,/g,"").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const v = Number(match[0]);
  return Number.isFinite(v) ? v : null;
}

function parseRange(text) {
  const clean = safeText(text).replace(/,/g,"");
  if (!clean) return null;
  const between = clean.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (between) return { low: Number(between[1]), high: Number(between[2]) };
  const less = clean.match(/(?:<=|<)\s*(-?\d+(?:\.\d+)?)/);
  if (less) return { high: Number(less[1]) };
  const greater = clean.match(/(?:>=|>)\s*(-?\d+(?:\.\d+)?)/);
  if (greater) return { low: Number(greater[1]) };
  return null;
}

function deriveStatus(valueText, normalText) {
  const value = parseNumber(valueText), range = parseRange(normalText);
  if (value === null || !range) return "alert";
  if (typeof range.low === "number" && value < range.low) return "low";
  if (typeof range.high === "number" && value > range.high) return "high";
  return "normal";
}

function buildAbnormalExplanation(name, status, language) {
  if (language === "hi") {
    if (status === "high") return `${name} normal se zyada hai. Doctor se milin.`;
    if (status === "low")  return `${name} normal se kam hai. Doctor se baat karein.`;
    return `${name} ko doctor ke saath samjhein.`;
  }
  if (status === "high") return `${name} is above normal — please review with your doctor.`;
  if (status === "low")  return `${name} is below normal — please discuss with your doctor.`;
  return `${name} should be interpreted by your doctor.`;
}

function extractRows(reportText, language) {
  const source = safeText(reportText);
  const regex = /([A-Za-z][A-Za-z0-9 ()/%+-]{1,80})\s*:\s*([<>]?\s*[-+]?\d[\d,]*(?:\.\d+)?(?:\s*[A-Za-z/%uUL\u00B5.-]+)?)\s*\(\s*Normal\s*:\s*([^)]+)\)/gi;
  const rows = [], seen = new Set();
  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = safeText(match[1]), value = safeText(match[2]), normal = safeText(match[3]);
    if (!name || !value || !normal) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, value, normal, status: deriveStatus(value, normal) });
  }
  const abnormalValues = rows.filter(r => r.status==="high"||r.status==="low").slice(0,8)
    .map(r => ({ name:r.name, value:r.value, normal:r.normal, status:r.status, explanation:buildAbnormalExplanation(r.name,r.status,language) }));
  const normalHighlights = rows.filter(r => r.status==="normal").slice(0,6)
    .map(r => `${r.name}: ${r.value} (Normal: ${r.normal})`);
  const visualHighlights = rows.slice(0,4).map(r => ({
    label:r.name, patientValue:r.value, normalRange:r.normal, status:r.status,
    severityScore: r.status==="normal" ? 20 : 75,
    whyItMatters: r.status==="normal" ? "Within listed range." : buildAbnormalExplanation(r.name,r.status,language)
  }));
  return { rows, abnormalValues, normalHighlights, visualHighlights };
}

function buildFallbackAnalysis(reportText, language) {
  const structured = extractRows(reportText, language);
  const n = structured.abnormalValues.length;
  const riskLevel = n >= 4 ? "high" : n >= 2 ? "moderate" : "low";
  const isHindi = language === "hi";
  return {
    summary: n
      ? (isHindi ? `Aapki report mein ${n} value(s) normal range se bahar hain. Doctor se milein.` : `Your report has ${n} value(s) outside normal ranges. Please review with your doctor.`)
      : (isHindi ? "Adhiktar values normal range mein hain." : "Most values appear within listed ranges."),
    humorComment: riskLevel==="low" && n===0
      ? (isHindi ? "Waah! Aapki report bahut achhi hai!" : "Yehh, you rocked it! Report looks healthy!") : "",
    abnormalValues: structured.abnormalValues,
    nextSteps: isHindi
      ? ["Doctor se milkar report discuss karein.","Doctor ki salah ke bina test repeat na karein.","Symptoms, paani, neend track karein."]
      : ["Book a doctor follow-up.","Repeat tests only if your clinician advises.","Track symptoms, hydration, and sleep."],
    detailedInsights: isHindi
      ? ["Range se bahar values ko symptoms ke saath samjhein.","Ek akeli report final diagnosis nahi hoti.","Serious symptoms mein turant doctor se milein."]
      : ["Out-of-range values need clinical context.","A single report is not a final diagnosis.","Seek urgent care if symptoms worsen."],
    normalHighlights: structured.normalHighlights.length ? structured.normalHighlights : [isHindi ? "Kuch values normal hain." : "Some values are within normal range."],
    lifestyleTips: isHindi
      ? ["Balanced diet lein.","Paani peeyein aur exercise karein.","Neend ka schedule banayein."]
      : ["Keep balanced meals.","Stay hydrated and active.","Maintain regular sleep routines."],
    watchSymptoms: isHindi
      ? ["Chest pain, saans lene mein takleef, ya tez bukhar par doctor se milein."]
      : ["Seek urgent care for chest pain, breathing trouble, or high fever."],
    glossary: [
      { term:"Hemoglobin", meaning: isHindi ? "Khoon ka protein jo oxygen le jaata hai." : "A blood protein that carries oxygen." },
      { term:"WBC", meaning: isHindi ? "White blood cells jo infection se ladte hain." : "White blood cells that fight infection." },
      { term:"Creatinine", meaning: isHindi ? "Kidney function check karne ka marker." : "A marker used for kidney function." }
    ],
    riskLevel,
    visualHighlights: structured.visualHighlights,
    doctorFollowUp: isHindi ? "Doctor se salah lein." : "Please consult your doctor before starting any medicines."
  };
}

function normalizeAnalysis(raw, language) {
  const fallback = buildFallbackAnalysis("", language);
  const abnormalValues = Array.isArray(raw?.abnormalValues) ? raw.abnormalValues : [];
  const riskLevelRaw = safeText(raw?.riskLevel).toLowerCase();
  const riskLevel = ["low","moderate","high"].includes(riskLevelRaw) ? riskLevelRaw
    : abnormalValues.length >= 4 ? "high" : abnormalValues.length >= 2 ? "moderate" : "low";
  return {
    summary: safeText(raw?.summary, fallback.summary),
    humorComment: riskLevel==="low" && !abnormalValues.length ? (safeText(raw?.humorComment)||fallback.humorComment) : "",
    abnormalValues: abnormalValues.length ? abnormalValues : fallback.abnormalValues,
    nextSteps: Array.isArray(raw?.nextSteps) && raw.nextSteps.length ? raw.nextSteps : fallback.nextSteps,
    detailedInsights: Array.isArray(raw?.detailedInsights) && raw.detailedInsights.length ? raw.detailedInsights : fallback.detailedInsights,
    normalHighlights: Array.isArray(raw?.normalHighlights) && raw.normalHighlights.length ? raw.normalHighlights : fallback.normalHighlights,
    lifestyleTips: Array.isArray(raw?.lifestyleTips) && raw.lifestyleTips.length ? raw.lifestyleTips : fallback.lifestyleTips,
    watchSymptoms: Array.isArray(raw?.watchSymptoms) && raw.watchSymptoms.length ? raw.watchSymptoms : fallback.watchSymptoms,
    glossary: Array.isArray(raw?.glossary) && raw.glossary.length ? raw.glossary : fallback.glossary,
    riskLevel,
    visualHighlights: Array.isArray(raw?.visualHighlights) && raw.visualHighlights.length ? raw.visualHighlights : fallback.visualHighlights,
    doctorFollowUp: safeText(raw?.doctorFollowUp, fallback.doctorFollowUp)
  };
}

// ─── PROMPT BUILDERS ─────────────────────────────────────────────────────────

function buildAnalyzePrompt(reportText, language, sourceType) {
  const isHindi = language === "hi";
  const langName = isHindi ? "Hindi" : "English";
  const sourceHint = sourceType === "image"
    ? "Input: Medical report image — extract ALL visible values, test names, units, and normal ranges."
    : "Input: Plain text report.";
  const hindiRule = isHindi
    ? "\nCRITICAL: Write ALL text fields in Hindi Devanagari script. Test names/values/units may stay in original form.\n" : "";

  return `You are MediSimplify — a patient-safe medical report simplifier.
Language for ALL text: ${langName}.${hindiRule}
${sourceHint}

RULES:
1. Extract ALL test values from the report.
2. Compare patient value to normal range. If outside → ABNORMAL.
3. Return ONLY valid JSON. No markdown, no prose outside JSON.
4. Keep each text field SHORT (1-2 sentences max).

JSON SCHEMA:
{
  "summary": "2-3 short sentences",
  "humorComment": "upbeat sentence ONLY if low risk with no abnormal values, else empty string",
  "detailedInsights": ["3-5 insight points"],
  "normalHighlights": ["TestName: Value (Normal: Range) — max 5"],
  "abnormalValues": [{"name":"","value":"","normal":"","status":"high|low","explanation":"1 sentence"}],
  "nextSteps": ["3-4 steps"],
  "lifestyleTips": ["3-4 tips"],
  "watchSymptoms": ["2-4 red-flag symptoms"],
  "glossary": [{"term":"","meaning":"1 sentence"}],
  "riskLevel": "low|moderate|high",
  "visualHighlights": [{"label":"","patientValueNumeric":0,"minNormalNumeric":0,"maxNormalNumeric":0,"unit":"","status":"low|high|normal|alert","whyItMatters":"1 sentence"}],
  "doctorFollowUp": "1 sentence"
}

CALIBRATION:
Hemoglobin 9.2 vs 13.5-17.5 → low (abnormal)
WBC 14500 vs 4500-11000 → high (abnormal)
Fasting Glucose 145 vs 70-100 → high (abnormal)
Cholesterol 210 vs <200 → high (abnormal)
Creatinine 1.1 vs 0.7-1.3 → normal

Report:
"""${safeText(reportText).slice(0, 4000)}"""`;
}

function buildSmartChatFallback(userQuestion, reportContext, isHindi) {
  const q = safeText(userQuestion).toLowerCase();
  const ctx = (reportContext && typeof reportContext === "object") ? reportContext : {};
  const abnormal = Array.isArray(ctx.abnormalValues) ? ctx.abnormalValues : [];
  const normal   = Array.isArray(ctx.normalHighlights) ? ctx.normalHighlights : [];
  const steps    = Array.isArray(ctx.nextSteps) ? ctx.nextSteps : [];
  const tips     = Array.isArray(ctx.lifestyleTips) ? ctx.lifestyleTips : [];
  const watch    = Array.isArray(ctx.watchSymptoms) ? ctx.watchSymptoms : [];
  const risk = ctx.riskLevel || "low", summary = ctx.summary || "";

  const matched = abnormal.find(v => q.includes(v.name.toLowerCase()));
  if (matched) {
    const dir = matched.status==="high" ? (isHindi?"सामान्य से अधिक":"above normal") : (isHindi?"सामान्य से कम":"below normal");
    return isHindi
      ? `आपका ${matched.name} ${matched.value} है, जो ${dir} है (सामान्य: ${matched.normal||"?"})। कृपया डॉक्टर से मिलें।`
      : `Your ${matched.name} is ${matched.value}, which is ${dir} (Normal: ${matched.normal||"?"}). Please consult your doctor.`;
  }
  if (q.includes("abnormal")||q.includes("high")||q.includes("low")||q.includes("problem")||q.includes("असामान्य")) {
    if (!abnormal.length) return isHindi?"आपकी रिपोर्ट में कोई असामान्य मान नहीं।":"No abnormal values found.";
    const list = abnormal.map(v=>isHindi?`• ${v.name}: ${v.value} — ${v.status==="high"?"अधिक":"कम"}`:`• ${v.name}: ${v.value} — ${v.status}`).join("\n");
    return isHindi?`${abnormal.length} असामान्य मान:\n${list}\nडॉक्टर से मिलें।`:`${abnormal.length} abnormal value(s):\n${list}\nPlease consult your doctor.`;
  }
  if (q.includes("risk")||q.includes("overall")||q.includes("summary")||q.includes("जोखिम")) {
    const rm={low:isHindi?"कम":"low",moderate:isHindi?"मध्यम":"moderate",high:isHindi?"अधिक":"high"}[risk]||risk;
    return isHindi?`जोखिम स्तर: "${rm}"। ${summary}`:`Risk level: "${rm}". ${summary}`;
  }
  if ((q.includes("step")||q.includes("next")||q.includes("क्या करें"))&&steps.length)
    return isHindi?`सुझाव:\n${steps.map((s,i)=>`${i+1}. ${s}`).join("\n")}`:`Next steps:\n${steps.map((s,i)=>`${i+1}. ${s}`).join("\n")}`;
  if ((q.includes("symptom")||q.includes("watch")||q.includes("लक्षण"))&&watch.length)
    return isHindi?`ध्यान दें:\n${watch.map(w=>`• ${w}`).join("\n")}`:`Watch for:\n${watch.map(w=>`• ${w}`).join("\n")}`;
  if ((q.includes("lifestyle")||q.includes("diet")||q.includes("tip")||q.includes("जीवनशैली"))&&tips.length)
    return isHindi?`सुझाव:\n${tips.map(t=>`• ${t}`).join("\n")}`:`Tips:\n${tips.map(t=>`• ${t}`).join("\n")}`;
  if ((q.includes("normal")||q.includes("good")||q.includes("सामान्य"))&&normal.length)
    return isHindi?`सामान्य मान:\n${normal.slice(0,5).map(n=>`• ${n}`).join("\n")}`:`Normal values:\n${normal.slice(0,5).map(n=>`• ${n}`).join("\n")}`;
  const abnStr = abnormal.length?(isHindi?`${abnormal.length} असामान्य मान।`:`${abnormal.length} abnormal value(s).`):(isHindi?"कोई असामान्य मान नहीं।":"No abnormal values.");
  return isHindi?`रिपोर्ट: ${summary} ${abnStr} डॉक्टर से मिलें। ⚕️`:`Report: ${summary} ${abnStr} Please consult your doctor. ⚕️`;
}

function buildFallbackHindiAudioScript(analysis) {
  const abnormal = Array.isArray(analysis.abnormalValues) ? analysis.abnormalValues : [];
  const riskHindi = {low:"कम",moderate:"मध्यम",high:"अधिक"}[analysis.riskLevel||"low"]||"कम";
  let script = "नमस्ते! आपकी मेडिकल रिपोर्ट की जानकारी सुनिए। ";
  if (!abnormal.length) { script += "खुशखबरी — अधिकतर मान सामान्य हैं। "; }
  else {
    script += `${abnormal.length} असामान्य मान पाए गए हैं। `;
    abnormal.slice(0,4).forEach(v => { script += `आपका ${v.name} ${v.value} है, जो ${v.status==="high"?"सामान्य से अधिक":"सामान्य से कम"} है। `; });
  }
  script += `जोखिम स्तर ${riskHindi} है। अपने डॉक्टर से ज़रूर मिलें। धन्यवाद।`;
  return script;
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

/** POST /api/analyze */
app.post("/api/analyze", async (req, res) => {
  const { reportText, reportImage, language: languageInput } = req.body || {};
  const language = normalizeLanguage(languageInput);
  const textInput = safeText(reportText);

  let imageInput = null;
  try { imageInput = normalizeReportImage(reportImage); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (!textInput && !imageInput) return res.status(400).json({ error: "Provide reportText or reportImage." });

  const sourceType = imageInput ? "image" : "text";
  const prompt = buildAnalyzePrompt(textInput, language, sourceType);
  const model = imageInput ? VISION_MODEL : MAIN_MODEL;

  try {
    const userMsg = buildUserMessage(prompt, imageInput);
    const raw = await callOpenRouter(
      [{ role:"system", content:"You are a medical report analyzer. Return only valid JSON. No markdown." }, userMsg],
      model, 2000
    );

    let parsed;
    try { parsed = tryParseJson(raw); }
    catch (_) {
      console.warn("[/api/analyze] JSON parse failed, using fallback.");
      return res.json({ ...buildFallbackAnalysis(textInput, language), source:"fallback-parse" });
    }

    const aiResult = normalizeAnalysis(parsed, language);
    const fallback = buildFallbackAnalysis(textInput, language);
    const merged = {
      ...fallback, ...aiResult,
      abnormalValues: aiResult.abnormalValues || fallback.abnormalValues,
      visualHighlights: aiResult.visualHighlights || fallback.visualHighlights,
      normalHighlights: aiResult.normalHighlights || fallback.normalHighlights
    };
    if (merged.riskLevel==="low" && !merged.abnormalValues?.length && !safeText(merged.humorComment)) {
      merged.humorComment = language==="hi"
        ? "वाह! आपकी रिपोर्ट बहुत अच्छी है। ऐसे ही स्वस्थ रहें!"
        : "Yehh, you rocked it! Your report looks mostly healthy. Keep it up!";
    }
    return res.json(merged);
  } catch (error) {
    console.error("[/api/analyze] Error:", error.message);
    if (!textInput) return res.status(503).json({ error:"Image analysis temporarily unavailable. Please try text instead." });
    return res.json({ ...buildFallbackAnalysis(textInput, language), source:"fallback" });
  }
});

/** POST /api/chat */
app.post("/api/chat", async (req, res) => {
  const { messages, latestMessage, clearContext, reportContext, language: languageInput } = req.body || {};
  const language = normalizeLanguage(languageInput);
  const isHindi = language === "hi";

  if (!GROQ_API_KEY) return res.status(503).json({ error: "AI service not configured." });

  let allMessages = [];
  if (safeText(latestMessage)) {
    allMessages = [{ role: "user", content: safeText(latestMessage) }];
  } else if (Array.isArray(messages)) {
    allMessages = messages
      .filter(m => m && typeof m.content === "string" && m.content.trim())
      .map(m => ({ role: m.role === "assistant" || m.role === "model" ? "assistant" : "user", content: m.content.trim() }));
  }
  if (!allMessages.length) return res.status(400).json({ error: "messages or latestMessage is required." });

  if (clearContext) {
    const last = [...allMessages].reverse().find(m => m.role === "user");
    allMessages = last ? [last] : allMessages.slice(-1);
  }

  const contextStr = reportContext ? JSON.stringify(reportContext) : "No report analyzed yet.";
  const langInstruction = isHindi ? "हमेशा हिंदी में देवनागरी लिपि में जवाब दें। सरल भाषा में बोलें।" : "Always reply in clear, friendly English.";

  const systemPrompt = `You are MediSimplify AI — a friendly medical report assistant.
${langInstruction}

Patient's medical report:
${contextStr}

Rules:
- Answer ONLY based on the report data above.
- Explain medical terms simply. NEVER diagnose or recommend specific medicines.
- Be warm and empathetic. Maximum 5 sentences per reply.`;

  try {
    const reply = await callOpenRouter(
      [{ role: "system", content: systemPrompt }, ...allMessages],
      CHAT_MODEL,
      700
    );
    return res.json({ reply: reply || (isHindi ? "कृपया डॉक्टर से सलाह लें।" : "Please consult your doctor for advice.") });
  } catch (error) {
    console.error("[/api/chat] Full error:", error.message);
    if (isLikelyAiError(error)) {
      return res.json({ reply: buildSmartChatFallback(allMessages[allMessages.length-1].content, reportContext, isHindi), source: "fallback" });
    }
    return res.status(500).json({ error: "Chat failed.", details: error.message });
  }
});
/** POST /api/translate */
app.post("/api/translate", async (req, res) => {
  const { text, targetLanguage } = req.body || {};
  if (!text || typeof text !== "string") 
    return res.status(400).json({ error: "text is required." });

  const language = normalizeLanguage(targetLanguage);
  const isHindi = language === "hi";

  const prompt = `You are a professional medical translator.
Translate the text below into ${isHindi ? "Hindi" : "English"}.

STRICT RULES:
- If Hindi: Output **ONLY** pure Hindi in Devanagari script. NO English words, NO Roman script, NO Hinglish.
- Keep all medical terms, numbers, units and test names exactly the same.
- Make it simple and natural for patients to understand.
- Do not add any extra explanation.

TEXT:
${text}`;

  try {
    let translated = await callOpenRouter(
      [
        { 
          role: "system", 
          content: isHindi 
            ? "You are a Hindi medical translator. ALWAYS reply in pure Devanagari Hindi ONLY. Never use any English or Latin characters." 
            : "You are a professional medical translator."
        },
        { role: "user", content: prompt }
      ],
      MAIN_MODEL,
      1000
    );

    translated = translated.trim();

    // Extra safety net for Hindi
    if (isHindi && !containsDevanagari(translated)) {
      console.warn("[/api/translate] Retrying with MAXIMUM Hindi enforcement...");
      translated = await callOpenRouter(
        [
          { role: "system", content: "CRITICAL: Reply ONLY in Hindi Devanagari script. No English allowed at all." },
          { role: "user", content: prompt + "\n\nMUST USE ONLY DEVANAGARI HINDI." }
        ],
        MAIN_MODEL,
        1000
      );
      translated = translated.trim();
    }

    if (!translated) translated = text;

    if (isHindi && !containsDevanagari(translated)) {
      return res.status(422).json({ error: "Hindi translation failed. Please try again." });
    }

    return res.json({ translatedText: translated });
  } catch (error) {
    console.error("[/api/translate] Error:", error.message);
    return res.status(500).json({ 
      error: isHindi ? "Hindi translation temporarily unavailable." : "Translation failed." 
    });
  }
});
    // Extra safety for Hindi
    if (isHindi && !containsDevanagari(translated)) {
      console.warn("[/api/translate] Retrying with ultra-strict Hindi prompt...");
      translated = await callOpenRouter(
        [
          { role: "system", content: "You MUST reply ONLY in Hindi Devanagari script. Never use any English or Roman letters." },
          { role: "user", content: prompt + "\n\nCRITICAL: Use ONLY Devanagari Hindi. No English allowed." }
        ],
        MAIN_MODEL,
        900
      );
      translated = translated.trim();
    }

    if (!translated) translated = text;

    if (isHindi && !containsDevanagari(translated)) {
      return res.status(422).json({ error: "Hindi translation unavailable right now. Please try again." });
    }

    return res.json({ translatedText: translated });
  } catch (error) {
    console.error("[/api/translate] Error:", error.message);
    if (isLikelyAiError(error)) {
      return res.status(503).json({ error: isHindi ? "Hindi translation temporarily unavailable." : "Translation service busy. Please try again." });
    }
    return res.status(500).json({ error: "Translation failed.", details: error.message });
  }
});

/** POST /api/ocr-extract */
app.post("/api/ocr-extract", async (req, res) => {
  const { reportImage } = req.body || {};
  let imageInput = null;
  try { imageInput = normalizeReportImage(reportImage); }
  catch (e) { return res.status(400).json({ error:e.message }); }
  if (!imageInput) return res.status(400).json({ error:"reportImage is required." });

  const prompt = `Extract ALL visible text from this medical report image exactly as it appears.
- Include ALL test names, values, units, normal ranges, dates, lab names, headers.
- Preserve line structure. Output plain text only — no JSON, no markdown.
- Write [UNCLEAR] for unreadable parts.`;

  try {
    const userMsg = buildUserMessage(prompt, imageInput);
    const raw = await callOpenRouter(
      [{ role:"system", content:"You are an OCR assistant for medical reports. Extract text accurately." }, userMsg],
      VISION_MODEL, 2000
    );
    return res.json({ extractedText: stripJsonFences(raw).trim() || "No readable text found." });
  } catch (error) {
    if (isLikelyAiError(error)) return res.status(503).json({ error:"OCR service temporarily unavailable." });
    console.error("[/api/ocr-extract] Error:", error.message);
    return res.status(500).json({ error:"Failed to extract text.", details:error.message });
  }
});

/** POST /api/hindi-audio-summary */
app.post("/api/hindi-audio-summary", async (req, res) => {
  const { analysis } = req.body || {};
  if (!analysis || typeof analysis!=="object") return res.status(400).json({ error:"analysis object is required." });

  const abnormalList = Array.isArray(analysis.abnormalValues) && analysis.abnormalValues.length
    ? analysis.abnormalValues.map(v=>`${v.name}: ${v.value} (Normal: ${v.normal}) — ${v.status==="high"?"zyada":"kam"}`).join("\n")
    : "Koi bhi value normal se bahar nahi mili.";
  const riskHindi = {high:"zyada",moderate:"medium",low:"kam"}[analysis.riskLevel||"low"]||"kam";

  const prompt = `Write a natural, conversational Hindi audio summary of this medical report.

Report:
Risk: ${analysis.riskLevel||"low"} (${riskHindi})
Abnormal: ${abnormalList}
Normal: ${(analysis.normalHighlights||[]).slice(0,4).join(", ")||"Adhiktar theek hain."}

Requirements:
1. PURE Hindi Devanagari only. No English or Hinglish.
2. Start: "नमस्ते! आपकी मेडिकल रिपोर्ट की जानकारी सुनिए।"
3. Mention each abnormal value naturally.
4. End: "अपने डॉक्टर से ज़रूर मिलें।"
5. 5-10 natural sentences. No bullet points.

Write ONLY the Hindi audio script.`;

  try {
    let script = (await callOpenRouter(
      [{ role:"system", content:"You are a Hindi-speaking health assistant. Write only Hindi Devanagari." }, { role:"user", content:prompt }],
      MAIN_MODEL, 600
    )).trim();
    if (!containsDevanagari(script)) script = buildFallbackHindiAudioScript(analysis);
    return res.json({ hindiScript:script });
  } catch (error) {
    if (isLikelyAiError(error)) return res.json({ hindiScript:buildFallbackHindiAudioScript(analysis), source:"fallback" });
    console.error("[/api/hindi-audio-summary] Error:", error.message);
    return res.status(500).json({ error:"Failed to generate Hindi audio summary.", details:error.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    provider: "Groq", 
    model: MAIN_MODEL, 
    features: ["analyze","chat","translate","ocr-extract","hindi-audio-summary"], 
    timestamp: new Date().toISOString() 
  });
}); 

// ─── STATIC FALLBACK ──────────────────────────────────────────────────────────
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

// ─── START SERVER ─────────────────────────────────────────────────────────────
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  function startServer(port) {
    const server = app.listen(port);
    server.on("listening", () => {
      console.log(`✅ MediSimplify server running → http://localhost:${port}`);
      console.log(`   Provider: OpenRouter  |  Model: ${MAIN_MODEL}`);
      console.log(`   API Key: ${GROQ_API_KEY ? "[SET]" : "[MISSING — set GROQ_API_KEY in .env]"}`);    });
    server.on("error", (err) => {
      if (err.code==="EADDRINUSE") { server.close(); startServer(port+1); }
      else { console.error("❌ Server error:", err.message); process.exit(1); }
    });
  }
  startServer(PORT);
}

module.exports = app;
module.exports.handler = serverless(app);