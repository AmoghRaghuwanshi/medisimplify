/**
 * MediSimplify - AI Medical Report Simplifier
 * Groq-powered backend | No database | PDFs stored in browser only
 * Works on Netlify as Serverless Function
 */

const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const serverless = require("serverless-http");

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";

const MAIN_MODEL   = process.env.GROQ_MODEL        || "llama-3.3-70b-versatile";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const CHAT_MODEL   = process.env.GROQ_CHAT_MODEL   || "llama-3.3-70b-versatile";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname))); // Serve frontend files

// ─────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function stripJsonFences(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  return rawText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function tryParseJson(rawText) {
  const cleaned = stripJsonFences(rawText);
  try { return JSON.parse(cleaned); } catch (_) {}
  // Fallback parsing logic (your original)
  const fb = cleaned.indexOf("{"), lb = cleaned.lastIndexOf("}");
  if (fb !== -1 && lb > fb) try { return JSON.parse(cleaned.slice(fb, lb + 1)); } catch (_) {}
  const fa = cleaned.indexOf("["), la = cleaned.lastIndexOf("]");
  if (fa !== -1 && la > fa) try { return JSON.parse(cleaned.slice(fa, la + 1)); } catch (_) {}
  throw new Error("Could not parse JSON from Groq response.");
}

async function callGroq(messages, model = MAIN_MODEL, maxTokens = 1500) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing. Please add it in Netlify Environment Variables.");

  const response = await fetch(GROQ_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.1, messages })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from Groq.");
  return content.trim();
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function normalizeReportImage(input) {
  if (!input || typeof input !== "object") return null;
  const mimeType = safeText(input.mimeType).toLowerCase();
  let data = safeText(input.data).replace(/\s+/g, "").replace(/^data:[^,]+,/, "");
  if (!mimeType || !data) return null;
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Unsupported image type. Please upload JPG, PNG, or WEBP.");
  return { mimeType, data };
}

function normalizeLanguage(language) { return language === "hi" ? "hi" : "en"; }

// ─────────────────────────────────────────────────────────────
// YOUR ORIGINAL HELPER FUNCTIONS (Add them here from your old file)
// extractRows, deriveStatus, buildAbnormalExplanation, buildFallbackAnalysis, 
// normalizeAnalysis, buildAnalyzePrompt, buildSmartChatFallback, 
// buildFallbackHindiAudioScript, etc.
// ─────────────────────────────────────────────────────────────

// Paste all remaining helper functions from your original server.js here...

// ─────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────

/** POST /api/analyze - Handles text or image (NOT direct PDF) */
app.post("/api/analyze", async (req, res) => {
  try {
    const { reportText, reportImage, language: languageInput } = req.body || {};
    const language = normalizeLanguage(languageInput);
    const textInput = safeText(reportText);

    let imageInput = null;
    try {
      imageInput = normalizeReportImage(reportImage);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!textInput && !imageInput) {
      return res.status(400).json({ error: "Provide reportText or reportImage (JPG/PNG/WEBP). Direct PDF upload is not supported by Groq vision models." });
    }

    const sourceType = imageInput ? "image" : "text";
    const prompt = buildAnalyzePrompt(textInput, language, sourceType); // Use your original prompt builder
    const model = imageInput ? VISION_MODEL : MAIN_MODEL;

    const userMsg = imageInput 
      ? { role: "user", content: [{ type: "image_url", image_url: { url: `data:${imageInput.mimeType};base64,${imageInput.data}` } }, { type: "text", text: prompt }] }
      : { role: "user", content: prompt };

    const raw = await callGroq([{ role: "system", content: "You are a medical report analyzer. Return only valid JSON." }, userMsg], model, 2000);

    let parsed;
    try { parsed = tryParseJson(raw); } catch (_) {
      console.warn("JSON parse failed, using fallback");
      return res.json({ ...buildFallbackAnalysis(textInput, language), source: "fallback" });
    }

    const aiResult = normalizeAnalysis(parsed, language);
    const fallback = buildFallbackAnalysis(textInput, language);
    const merged = { ...fallback, ...aiResult };

    res.json(merged);
  } catch (error) {
    console.error("[/api/analyze] Error:", error.message);
    res.status(500).json({ error: "Analysis failed. " + error.message });
  }
});

/** POST /api/chat - Chatbot (unchanged - no impact) */
app.post("/api/chat", async (req, res) => {
  // Your original /api/chat code goes here exactly as before
  // (messages, reportContext, language, fallback, etc.)
  // Paste your full original /api/chat logic here
});

/** Other routes - Paste your original /api/translate, /api/ocr-extract, /api/hindi-audio-summary here */

// Health check
app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    provider: "Groq", 
    note: "PDFs must be converted to text or images before sending. Storage is handled in browser only."
  });
});

// Frontend fallback (fixes 404 for SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─────────────────────────────────────────────────────────────
// Server Setup
// ─────────────────────────────────────────────────────────────

if (process.env.NETLIFY) {
  module.exports.handler = serverless(app);
} else {
  const PORT = Number(process.env.PORT) || 3001;
  app.listen(PORT, () => {
    console.log(`✅ MediSimplify running on http://localhost:${PORT}`);
  });
}

module.exports = app;