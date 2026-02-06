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
const sharp = require('sharp');

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

// API Configuration — IDfy Face Match
const IDFY_API_KEY = process.env.IDFY_API_KEY || '';
const IDFY_ACCOUNT_ID = process.env.IDFY_ACCOUNT_ID || '';
// IDfy v2 REST API endpoint (NOT GraphQL)
const IDFY_API_URL = 'https://api.idfy.com/v2/tasks';

/**
 * Compress image to ensure it's under SpringScan's size limit
 * Target: ~30KB base64 per image (under 100KB total payload)
 */
async function compressImage(base64String, maxSizeKB = 30) {
  const buffer = Buffer.from(base64String, 'base64');

  let quality = 70;
  let compressed = await sharp(buffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();

  // If still too large, reduce quality further
  while (compressed.length > maxSizeKB * 1024 && quality > 20) {
    quality -= 10;
    compressed = await sharp(buffer)
      .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  }

  return compressed.toString('base64');
}

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
    // Get images and document type
    let idImageBase64, selfieBase64, docType;

    if (req.files?.idImage && req.files?.selfieImage) {
      idImageBase64 = req.files.idImage[0].buffer.toString('base64');
      selfieBase64 = req.files.selfieImage[0].buffer.toString('base64');
      docType = req.body.docType;
    } else if (req.body.idImage && req.body.selfieImage) {
      idImageBase64 = req.body.idImage.replace(/^data:image\/\w+;base64,/, '');
      selfieBase64 = req.body.selfieImage.replace(/^data:image\/\w+;base64,/, '');
      docType = req.body.docType;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Both idImage and selfieImage are required'
      });
    }

    // Validate document type is provided
    if (!docType) {
      return res.status(400).json({
        success: false,
        error: 'Document type is required. Please select a document type.'
      });
    }

    // Call IDfy Face Match API directly
    const result = await callIdfyFaceMatch(idImageBase64, selfieBase64, docType);
    res.json(result);

  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data;
    console.error('Face Match Error:', error.message);
    console.error('  Status:', status);
    console.error('  Response:', JSON.stringify(detail)?.substring(0, 500));

    // User-friendly error messages
    let userMessage = error.message || 'Verification failed. Please try again.';

    res.status(status || 500).json({
      success: false,
      error: userMessage,
      detail: detail
    });
  }
});

/**
 * IDfy Face Match API
 * Simple 1-step process: Send 2 images, get match score
 * No person creation or OCR needed - direct face comparison
 */

async function callIdfyFaceMatch(idImageBase64, selfieBase64, docType) {
  // Validate IDfy credentials
  if (!IDFY_API_KEY || !IDFY_ACCOUNT_ID) {
    throw new Error('IDfy credentials not configured. Add IDFY_API_KEY and IDFY_ACCOUNT_ID to Replit Secrets.');
  }

  console.log('Using IDfy Face Match API');
  console.log('Document type:', docType);

  // Compress images
  console.log('Compressing images...');
  console.log('Original sizes - ID:', idImageBase64.length, 'Selfie:', selfieBase64.length);

  const compressedId = await compressImage(idImageBase64);
  const compressedSelfie = await compressImage(selfieBase64);

  console.log('Compressed sizes - ID:', compressedId.length, 'Selfie:', compressedSelfie.length);

  try {
    // IDfy Face Compare - REST API v2
    console.log('Calling IDfy Face Compare API (REST v2)...');

    const taskId = `face_compare_${Date.now()}`;

    // IDfy v2 REST API payload
    // Task type: 'face_compare' (not 'face_match')
    // Base64: Raw base64 without data: prefix
    // Field names: Try common patterns
    const payload = {
      tasks: [
        {
          type: 'face_compare',
          task_id: taskId,
          group_id: IDFY_ACCOUNT_ID,
          data: {
            image1: compressedId,
            image2: compressedSelfie
          }
        }
      ]
    };

    console.log('Payload:', JSON.stringify({
      tasks: [{
        type: 'face_compare',
        task_id: taskId,
        group_id: IDFY_ACCOUNT_ID,
        data: {
          image1: `[base64: ${compressedId.length} chars]`,
          image2: `[base64: ${compressedSelfie.length} chars]`
        }
      }]
    }, null, 2));

    const response = await axios.post(
      IDFY_API_URL,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': IDFY_API_KEY
        },
        timeout: 60000
      }
    );

    console.log('IDfy Response:', JSON.stringify(response.data, null, 2).substring(0, 1000));

    // IDfy v2 returns array of results
    const results = response.data;
    if (!results || results.length === 0) {
      throw new Error('IDfy API returned no results');
    }

    const data = results[0]; // Get first task result

    // Check for errors
    if (data.error || data.status === 'failure') {
      throw new Error(`IDfy Face Match Error: ${data.error || data.message || 'Unknown error'}`);
    }

    // Extract match score (IDfy returns as string like "99.0")
    const score = parseFloat(data.match_score) || 0;

    // IDfy match_band: green=high, yellow=medium, red=low, gray=unable
    const matchBand = data.match_band?.toLowerCase() || 'gray';
    const faceMatched = matchBand === 'green' || matchBand === 'yellow';

    // Map IDfy's match_band to our confidence levels
    let confidenceLevel, status;
    if (matchBand === 'green') {
      confidenceLevel = 'HIGH';
      status = 'VERIFIED';
    } else if (matchBand === 'yellow') {
      confidenceLevel = 'MEDIUM';
      status = 'REVIEW';
    } else {
      confidenceLevel = 'LOW';
      status = 'FAILED';
    }

    return {
      success: true,
      data: {
        request_id: data.request_id || data.task_id || taskId,
        match_score: score,
        match_percentage: score,
        match_band: matchBand.toUpperCase(),
        status: status,
        confidence_level: confidenceLevel,
        face_matched: faceMatched,
        match_result: {
          match_band: data.match_band,
          match_score: data.match_score
        },
        liveness: { status: 'N/A', confidence: 0 },
        face_1: {
          detected: data.face_1?.status === 'face_detected',
          quality: data.face_1?.quality || 'unknown'
        },
        face_2: {
          detected: data.face_2?.status === 'face_detected',
          quality: data.face_2?.quality || 'unknown'
        },
        processed_at: new Date().toISOString(),
        mode: 'idfy-rest-v2',
        raw_response: response.data
      }
    };
  } catch (error) {
    console.error('IDfy API error:', error.message);
    console.error('Error response data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Error status:', error.response?.status);

    // Check for API errors in response
    if (error.response?.data) {
      const errorData = error.response.data;
      // v2 API returns errors in different formats
      if (Array.isArray(errorData) && errorData[0]?.error) {
        throw new Error(`IDfy API Error: ${errorData[0].error}`);
      }
      if (errorData.error) {
        throw new Error(`IDfy API Error: ${errorData.error}`);
      }
      if (errorData.message) {
        throw new Error(`IDfy API Error: ${errorData.message}`);
      }
    }

    throw error;
  }
}

// Serve app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔐 SpringVerify Face Match`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Face Match API: IDfy REST v2 (api.idfy.com/v2)`);
  console.log(`   IDfy API Key: ${IDFY_API_KEY ? 'Configured ✓' : 'NOT SET - add IDFY_API_KEY to Replit Secrets'}`);
  console.log(`   IDfy Group ID: ${IDFY_ACCOUNT_ID ? 'Configured ✓' : 'NOT SET - add IDFY_ACCOUNT_ID to Replit Secrets'}`);
  console.log(`   Report: Client-side PDF generation\n`);
});

module.exports = app;
