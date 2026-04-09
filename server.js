/**
 * MediSimplify - Backend Server (Groq + Browser Local PDF Storage)
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
app.use(express.static(path.join(__dirname)));   // Serve your frontend files

// ─── All your existing helper functions (safeText, stripJsonFences, tryParseJson, etc.) ───
// Copy-paste ALL your utility functions here exactly as they were 
// (safeText, normalizeReportImage, extractRows, buildFallbackAnalysis, etc.)
// ... [Keep all your functions from original file: buildAnalyzePrompt, buildSmartChatFallback, etc.] ...

// ─── Keep ALL your API routes exactly as they are ───
// /api/analyze, /api/chat, /api/translate, /api/ocr-extract, /api/hindi-audio-summary, /api/health

// Example: Only showing one route for brevity — keep all others unchanged
app.post("/api/analyze", async (req, res) => {
  // ... your existing code for analyze (no changes needed) ...
});

// Keep /api/chat, /api/ocr-extract, etc. exactly the same

// Health check
app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    provider: "Groq", 
    model: MAIN_MODEL,
    note: "PDFs are stored locally in browser (IndexedDB). No database used."
  });
});

// Catch-all for frontend (SPA support)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── Export for Netlify Functions ───
if (process.env.NETLIFY) {
  module.exports.handler = serverless(app);
} else {
  // Local development
  const PORT = Number(process.env.PORT) || 3001;
  app.listen(PORT, () => {
    console.log(`✅ MediSimplify running locally → http://localhost:${PORT}`);
    console.log(`   Groq Key: ${GROQ_API_KEY ? "SET" : "MISSING"}`);
  });
}

module.exports = app;  
 // Also keep for local
// ... (all your routes and code stay the same) ...

// Catch-all for frontend (SPA fallback)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Local development only
if (!process.env.NETLIFY) {
  const PORT = Number(process.env.PORT) || 3001;
  app.listen(PORT, () => {
    console.log(`✅ MediSimplify running on http://localhost:${PORT}`);
  });
}

module.exports = app;   // ← This line is CRITICAL for Netlify