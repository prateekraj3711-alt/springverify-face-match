/**
 * SpringVerify Face Match Server
 * Uses SpringScan API for face matching
 * Report is generated client-side (html2canvas + jsPDF)
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const Portkey = require('portkey-ai').default;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware — 100mb limit for base64 images
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));

// File upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// API Configuration — Portkey AI Face Match
const PORTKEY_API_KEY = process.env.PORTKEY_API_KEY || '';
const PORTKEY_PROMPT_ID = process.env.PORTKEY_PROMPT_ID || 'pp-selfie-id-fa97d5';

// Initialize Portkey client
const portkey = PORTKEY_API_KEY ? new Portkey({
  apiKey: PORTKEY_API_KEY
}) : null;

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    mode: 'springscan',
    timestamp: new Date().toISOString()
  });
});

/**
 * Face Match API Endpoint
 */
app.post('/api/face-match', upload.fields([
  { name: 'idImage', maxCount: 1 },
  { name: 'selfieImage', maxCount: 1 }
]), async (req, res) => {
  try {
    // Get images
    let idImageBase64, selfieBase64;

    if (req.files?.idImage && req.files?.selfieImage) {
      idImageBase64 = req.files.idImage[0].buffer.toString('base64');
      selfieBase64 = req.files.selfieImage[0].buffer.toString('base64');
    } else if (req.body.idImage && req.body.selfieImage) {
      idImageBase64 = req.body.idImage.replace(/^data:image\/\w+;base64,/, '');
      selfieBase64 = req.body.selfieImage.replace(/^data:image\/\w+;base64,/, '');
    } else {
      return res.status(400).json({
        success: false,
        error: 'Both idImage and selfieImage are required'
      });
    }

    // Always call Portkey AI Face Match
    const result = await callPortkeyFaceMatch(idImageBase64, selfieBase64);
    res.json(result);

  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data;
    console.error('Face Match Error:', error.message);
    console.error('  Status:', status);
    console.error('  Response:', JSON.stringify(detail)?.substring(0, 500));
    res.status(status || 500).json({
      success: false,
      error: error.message || 'Internal server error',
      detail: detail
    });
  }
});

/**
 * Portkey AI Face Match
 * Compares selfie with ID document photo using AI
 */
async function callPortkeyFaceMatch(idImageBase64, selfieBase64) {
  if (!PORTKEY_API_KEY || !portkey) {
    throw new Error('Portkey API key not configured. Add PORTKEY_API_KEY to .env or Replit Secrets.');
  }

  console.log('Calling Portkey AI for face matching (Chat Completions API)');
  console.log('Image sizes - ID:', idImageBase64.length, 'Selfie:', selfieBase64.length);

  try {
    // Use Chat Completions API for vision tasks (not Prompt Completions)
    const response = await portkey.chat.completions.create({
      model: 'gpt-4-vision-preview',  // Vision-capable model
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${idImageBase64}`,
                detail: 'low'  // Faster, cheaper for face comparison
              }
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${selfieBase64}`,
                detail: 'low'
              }
            },
            {
              type: 'text',
              text: 'Compare these two face images. Determine if they show the same person. Provide: 1) Match result (Yes/No), 2) Confidence score (0-100). Format: "Match: [Yes/No], Confidence: [score]%"'
            }
          ]
        }
      ],
      max_tokens: 300
    });

    console.log('Portkey response:', JSON.stringify(response).substring(0, 500));

    // Parse AI response
    const aiText = response.choices?.[0]?.message?.content || '';

    // Try to extract match result from AI text response
    const matchResult = parseAIResponse(aiText);

    return {
      success: true,
      data: {
        request_id: response.id || `PK_${Date.now()}`,
        match_score: matchResult.score,
        match_percentage: matchResult.score,
        match_band: matchResult.score >= 85 ? 'HIGH' : matchResult.score >= 70 ? 'MEDIUM' : 'LOW',
        status: matchResult.match && matchResult.score >= 70 ? 'VERIFIED' : matchResult.score >= 50 ? 'REVIEW' : 'FAILED',
        confidence_level: matchResult.score >= 85 ? 'HIGH' : matchResult.score >= 70 ? 'MEDIUM' : 'LOW',
        face_matched: matchResult.match,
        liveness: { status: 'N/A', confidence: 0 },
        face_1: { detected: true, quality: 'GOOD' },
        face_2: { detected: true, quality: 'GOOD' },
        processed_at: new Date().toISOString(),
        mode: 'portkey-ai-vision',
        ai_response: aiText,
        raw_response: response
      }
    };
  } catch (error) {
    console.error('Portkey API error:', error);
    throw error;
  }
}

/**
 * Parse AI text response to extract match result
 * Adjust based on actual prompt output format
 */
function parseAIResponse(aiText) {
  // Default values
  let match = false;
  let score = 0;

  if (!aiText) return { match, score };

  const lowerText = aiText.toLowerCase();

  // Check for match indicators
  if (lowerText.includes('match') && (lowerText.includes('yes') || lowerText.includes('true') || lowerText.includes('positive'))) {
    match = true;
  }

  // Check for no match indicators
  if (lowerText.includes('no match') || lowerText.includes('not match') || lowerText.includes('different')) {
    match = false;
  }

  // Extract percentage (e.g., "95%", "85.5%")
  const percentMatch = aiText.match(/(\d+\.?\d*)%/);
  if (percentMatch) {
    score = parseFloat(percentMatch[1]);
  }

  // Extract decimal score (e.g., "0.95", "0.855")
  const decimalMatch = aiText.match(/score[:\s]+(\d+\.?\d*)/i);
  if (decimalMatch) {
    const val = parseFloat(decimalMatch[1]);
    score = val <= 1 ? val * 100 : val;
  }

  // Extract confidence (e.g., "confidence: 95")
  const confMatch = aiText.match(/confidence[:\s]+(\d+\.?\d*)/i);
  if (confMatch) {
    score = parseFloat(confMatch[1]);
  }

  // If score is high but no explicit match found, infer match
  if (score >= 70 && !lowerText.includes('not')) {
    match = true;
  }

  return { match, score };
}

// Serve app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔐 SpringVerify Face Match`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Face Match API: Portkey AI`);
  console.log(`   Portkey API Key: ${PORTKEY_API_KEY ? 'Configured ✓' : 'NOT SET - add PORTKEY_API_KEY to .env'}`);
  console.log(`   Prompt ID: ${PORTKEY_PROMPT_ID}`);
  console.log(`   Report: Client-side PDF generation\n`);
});

module.exports = app;
