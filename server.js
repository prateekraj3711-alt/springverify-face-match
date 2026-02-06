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
const IDFY_BASE_URL = 'https://eve.idfy.com/v3';

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
    // IDfy Face Match - Simple 1-step API call
    console.log('Calling IDfy Face Match API...');

    const response = await axios.post(
      `${IDFY_BASE_URL}/tasks/sync/face_match`,
      {
        task_id: `face_match_${Date.now()}`,
        group_id: IDFY_ACCOUNT_ID,
        data: {
          image1: compressedId,
          image2: compressedSelfie
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': IDFY_API_KEY,
          'account-id': IDFY_ACCOUNT_ID
        },
        timeout: 60000
      }
    );

    console.log('IDfy Response:', JSON.stringify(response.data).substring(0, 500));

    const data = response.data;
    const result = data.result || {};

    // Extract match score from IDfy response
    const score = result.match_score || result.confidence || result.score || 0;
    const faceMatched = result.match === true || score >= 70;

    const isHigh = score >= 85;
    const isMedium = score >= 70;

    return {
      success: true,
      data: {
        request_id: data.request_id || data.task_id || `IDFY_${Date.now()}`,
        match_score: score,
        match_percentage: score,
        match_band: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
        status: faceMatched && score >= 70 ? 'VERIFIED' : score >= 50 ? 'REVIEW' : 'FAILED',
        confidence_level: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
        face_matched: faceMatched,
        match_result: result,
        liveness: { status: result.liveness?.status || 'N/A', confidence: result.liveness?.confidence || 0 },
        face_1: { detected: result.face1_detected ?? true, quality: result.face1_quality || 'GOOD' },
        face_2: { detected: result.face2_detected ?? true, quality: result.face2_quality || 'GOOD' },
        processed_at: new Date().toISOString(),
        mode: 'idfy-direct',
        raw_response: data
      }
    };
  } catch (error) {
    console.error('IDfy API error:', error);
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
  console.log(`   Face Match API: IDfy Direct (eve.idfy.com)`);
  console.log(`   IDfy API Key: ${IDFY_API_KEY ? 'Configured ✓' : 'NOT SET - add IDFY_API_KEY to Replit Secrets'}`);
  console.log(`   IDfy Account ID: ${IDFY_ACCOUNT_ID ? 'Configured ✓' : 'NOT SET - add IDFY_ACCOUNT_ID to Replit Secrets'}`);
  console.log(`   Report: Client-side PDF generation\n`);
});

module.exports = app;
