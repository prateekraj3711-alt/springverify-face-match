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

// API Configuration — SpringScan Face Match
const SPRINGSCAN_API_URL = 'https://api.springscan.springverify.com/v4/faceMatch';
const SPRINGSCAN_TOKEN_KEY = process.env.SVD_TOKEN_KEY || '';

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

    // Always call SpringScan Face Match
    const result = await callSpringScanFaceMatch(idImageBase64, selfieBase64);
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
 * Create a person in SpringScan
 * Required before calling face match API
 */
async function createSpringScanPerson() {
  const timestamp = Date.now();
  const params = new URLSearchParams({
    first_name: `FaceMatch`,
    last_name: `${timestamp}`
  });

  const response = await axios.post('https://api.springscan.springverify.com/user/person', params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'tokenKey': SPRINGSCAN_TOKEN_KEY
    },
    timeout: 30000
  });

  return response.data._id;  // Return the person ID
}

/**
 * SpringScan Face Match API
 * Correct 3-step flow - Face matching happens automatically during OCR:
 * 1. Create person via /user/person
 * 2. Upload selfie via /user/person/{personId}/selfie (BEFORE OCR)
 * 3. Upload ID via /v4/ocr - returns face match results automatically
 *
 * Key insight: When selfie is already on the person, OCR response includes
 * faceMatched, matchResult, and matchedInformation fields automatically.
 * No need for separate /v4/faceMatch call!
 */
async function callSpringScanFaceMatch(idImageBase64, selfieBase64) {
  if (!SPRINGSCAN_TOKEN_KEY) {
    throw new Error('SpringScan token not configured. Add SVD_TOKEN_KEY to .env or Replit Secrets.');
  }

  const docType = 'ind_aadhaar';  // Document type - can be ind_aadhaar, ind_pan, ind_driving_license, etc.

  // Compress images to stay under SpringScan's payload limit
  console.log('Compressing images...');
  console.log('Original sizes - ID:', idImageBase64.length, 'Selfie:', selfieBase64.length);

  const compressedId = await compressImage(idImageBase64);
  const compressedSelfie = await compressImage(selfieBase64);

  console.log('Compressed sizes - ID:', compressedId.length, 'Selfie:', compressedSelfie.length);

  console.log('Step 1: Creating person in SpringScan');

  // Step 1: Create a person first
  const personId = await createSpringScanPerson();
  console.log('Created person with ID:', personId);

  try {
    // Step 2: Upload selfie FIRST (before OCR)
    console.log('Step 2: Uploading selfie to person');
    await axios.post(
      `https://api.springscan.springverify.com/user/person/${personId}/selfie`,
      { selfieurl: compressedSelfie },
      {
        headers: {
          'Content-Type': 'application/json',
          'tokenKey': SPRINGSCAN_TOKEN_KEY
        },
        timeout: 60000
      }
    );
    console.log('Selfie uploaded successfully');

    // Step 3: Upload ID via OCR - face matching happens automatically
    console.log('Step 3: Uploading ID document via OCR (face match will happen automatically)');
    const ocrResponse = await axios.post('https://api.springscan.springverify.com/v4/ocr', {
      personId: personId,
      docType: docType,
      document_front: compressedId,
      document_back: null,
      success_parameters: ['id_number']
    }, {
      headers: {
        'Content-Type': 'application/json',
        'tokenKey': SPRINGSCAN_TOKEN_KEY
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000
    });

    console.log('OCR Response (includes face match results):');
    console.log(JSON.stringify(ocrResponse.data, null, 2));

    const data = ocrResponse.data;

    // Extract face match results from OCR response
    // OCR response includes: faceMatched, matchResult, matchedInformation
    const faceMatched = data.faceMatched || false;
    const matchResult = data.matchResult || data.matchedInformation || {};

    // Extract match score from various possible field names
    const score = matchResult.confidence || matchResult.score ||
                  data.match_score || data.score || data.confidence ||
                  data.matchScore || data.confidenceScore || 0;

    const isMatch = faceMatched || data.isMatch || score >= 70;
    const isHigh = score >= 85;
    const isMedium = score >= 70;

    return {
      success: true,
      data: {
        request_id: data.request_id || data.transactionId || data.id || `SS_${Date.now()}`,
        person_id: personId,
        match_score: score,
        match_percentage: score,
        match_band: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
        status: isMatch && score >= 70 ? 'VERIFIED' : score >= 50 ? 'REVIEW' : 'FAILED',
        confidence_level: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
        face_matched: faceMatched,
        match_result: matchResult,  // Include full match result object
        ocr_data: data.ocrData || data.extracted_data || {},  // Include OCR extracted data
        liveness: { status: data.liveness?.status || 'N/A', confidence: data.liveness?.confidence || 0 },
        face_1: { detected: data.face_1?.detected ?? true, quality: data.face_1?.quality || 'GOOD' },
        face_2: { detected: data.face_2?.detected ?? true, quality: data.face_2?.quality || 'GOOD' },
        processed_at: new Date().toISOString(),
        mode: 'springscan-ocr-with-facematch',
        raw_response: data
      }
    };
  } catch (error) {
    console.error('SpringScan API error:', error);
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
  console.log(`   Face Match API: SpringScan /v4/faceMatch`);
  console.log(`   Token: ${SPRINGSCAN_TOKEN_KEY ? 'Configured ✓' : 'NOT SET - add SVD_TOKEN_KEY to .env'}`);
  console.log(`   Report: Client-side PDF generation\n`);
});

module.exports = app;
