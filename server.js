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
// IDfy v3 Face Compare endpoint (correct endpoint from documentation)
const IDFY_API_URL = 'https://eve.idfy.com/v3/tasks/async/compare/face';

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
    // IDfy Face Compare - v3 API
    console.log('=== Calling IDfy v3 Face Compare API ===');

    const taskId = `face_compare_${Date.now()}`;

    // IDfy v3 Face Compare API payload (correct format from documentation)
    // Uses data URIs for document1/document2 (supports both URL and base64)
    const dataUri1 = `data:image/jpeg;base64,${compressedId}`;
    const dataUri2 = `data:image/jpeg;base64,${compressedSelfie}`;

    const payload = {
      task_id: taskId,
      group_id: IDFY_ACCOUNT_ID,
      data: {
        document1: dataUri1,
        document2: dataUri2
      }
    };

    console.log('Calling IDfy v3 Face Compare (eve.idfy.com)');
    console.log('Task ID:', taskId);
    console.log('Group ID:', IDFY_ACCOUNT_ID);
    console.log('Document 1 size:', dataUri1.length);
    console.log('Document 2 size:', dataUri2.length);

    const response = await axios.post(
      IDFY_API_URL,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': IDFY_API_KEY,
          'account-id': IDFY_ACCOUNT_ID
        },
        timeout: 60000
      }
    );

    console.log('=== IDfy Initial Response ===');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('Response status:', response.status);
    console.log('=============================');

    // IDfy v3 async response: { request_id: "..." } (no status field in v3)
    const responseData = response.data;

    // Check if it's an async response (has request_id, which means async)
    if (responseData.request_id) {
      console.log('Task accepted (async). Request ID:', responseData.request_id);
      console.log('Polling for results...');

      // Poll for results using request_id
      // IDfy v3 polling endpoint pattern
      const pollUrl = `https://eve.idfy.com/v3/tasks?request_id=${responseData.request_id}`;
      let attempts = 0;
      const maxAttempts = 30; // 30 attempts = ~30 seconds

      console.log('Poll URL:', pollUrl);

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        attempts++;

        console.log(`Polling attempt ${attempts}/${maxAttempts}...`);

        try {
          const pollResponse = await axios.get(pollUrl, {
            headers: {
              'api-key': IDFY_API_KEY,
              'account-id': IDFY_ACCOUNT_ID
            }
          });

          const pollData = pollResponse.data;
          console.log('=== Poll Response ===');
          console.log(JSON.stringify(pollData, null, 2));
          console.log('====================');

          // Check if task is complete
          if (pollData.status === 'completed' || pollData.status === 'success') {
            // Task complete, use this data
            responseData.taskData = pollData;
            break;
          } else if (pollData.status === 'failed' || pollData.status === 'failure') {
            throw new Error(`IDfy task failed: ${pollData.error || pollData.message || 'Unknown error'}`);
          }

          // Continue polling if status is still 'in_progress' or 'pending'
        } catch (pollError) {
          // If 404, the endpoint might be wrong - log and continue
          if (pollError.response?.status === 404) {
            console.log('404 on poll attempt, endpoint might be incorrect');
            // On first attempt with 404, we know the endpoint is wrong
            if (attempts === 1) {
              throw new Error('Poll endpoint not found. IDfy might require webhook or different polling URL.');
            }
          } else {
            throw pollError; // Re-throw other errors
          }
        }
      }

      if (attempts >= maxAttempts) {
        throw new Error('Timeout waiting for IDfy task completion');
      }
    }

    // Extract result data
    const data = responseData.taskData || responseData;

    console.log('=== Final Data to Parse ===');
    console.log(JSON.stringify(data, null, 2));
    console.log('===========================');

    // Check for errors
    if (data.error || data.status === 'failure' || data.status === 'failed') {
      throw new Error(`IDfy Face Match Error: ${data.error || data.message || 'Unknown error'}`);
    }

    // Extract match score (IDfy returns as string like "99.0")
    const score = parseFloat(data.match_score) || 0;
    console.log('Extracted score:', score);

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
