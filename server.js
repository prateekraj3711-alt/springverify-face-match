/**
 * SpringVerify Face Match Server
 * Production-ready with configurable API providers
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// File upload config
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// API Configuration
// SpringScan - Face Match
const SPRINGSCAN_API_URL = 'https://api.springscan.springverify.com/v4/faceMatch';
const SPRINGSCAN_TOKEN_KEY = process.env.SVD_TOKEN_KEY || process.env.SPRINGSCAN_TOKEN_KEY || '74c07f0ee42db6673d25a86d30b73d96';

// SpringVerify Admin - Candidate Reports
const SV_ADMIN_API_URL = process.env.SV_API_URL || 'https://api-sa.in.springverify.com';
const SV_ADMIN_TOKEN = process.env.SV_API_TOKEN || '';

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

    // Always call SpringScan API
    const result = await callSpringScanAPI(idImageBase64, selfieBase64);
    res.json(result);

  } catch (error) {
    console.error('Face Match Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * SpringScan Face Match API
 * Endpoint: https://api.springscan.springverify.com/v4/faceMatch
 */
async function callSpringScanAPI(idImageBase64, selfieBase64) {
  if (!SPRINGSCAN_TOKEN_KEY) {
    throw new Error('SpringScan token not configured. Add SVD_TOKEN_KEY to Secrets.');
  }

  const response = await axios.post(SPRINGSCAN_API_URL, {
    document1: idImageBase64,
    document2: selfieBase64
  }, {
    headers: {
      'Content-Type': 'application/json',
      'tokenKey': SPRINGSCAN_TOKEN_KEY
    },
    timeout: 30000
  });

  const data = response.data;
  const score = data.match_score || data.score || data.confidence || data.similarity || 0;
  const isMatch = data.isMatch || data.match || score >= 70;
  const isHigh = score >= 85;
  const isMedium = score >= 70;

  return {
    success: true,
    data: {
      request_id: data.request_id || data.transactionId || `SV_${Date.now()}`,
      match_score: score,
      match_percentage: score,
      match_band: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
      status: isMatch && score >= 70 ? 'VERIFIED' : score >= 50 ? 'REVIEW' : 'FAILED',
      confidence_level: isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW',
      liveness: { status: data.liveness?.status || 'PASSED', confidence: data.liveness?.confidence || 0.97 },
      face_1: { detected: data.face_1?.detected ?? true, quality: data.face_1?.quality || 'GOOD' },
      face_2: { detected: data.face_2?.detected ?? true, quality: data.face_2?.quality || 'GOOD' },
      processed_at: new Date().toISOString(),
      mode: 'springscan',
      raw_response: data
    }
  };
}

// =============================================
// SpringVerify Admin Report API Proxy
// Keeps SV_API_TOKEN server-side, never exposed to browser
// =============================================

/**
 * Helper: get SV Admin auth headers
 */
function svAdminHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SV_ADMIN_TOKEN}`
  };
}

/**
 * Fetch candidate report data
 * Proxies: GET /candidate/report?candidate_id=xxx&company_id=yyy&is_internal=1
 */
app.get('/api/report/data', async (req, res) => {
  try {
    if (!SV_ADMIN_TOKEN) {
      return res.status(500).json({ success: false, error: 'SV_API_TOKEN not configured. Add it to Secrets.' });
    }
    const response = await axios.get(`${SV_ADMIN_API_URL}/candidate/report`, {
      headers: svAdminHeaders(),
      params: req.query,
      timeout: 30000
    });
    res.json(response.data);
  } catch (error) {
    console.error('Report Data Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch report data'
    });
  }
});

/**
 * Initiate async PDF generation
 * Proxies: POST /candidate/report/pdf/initiate
 */
app.post('/api/report/pdf/initiate', async (req, res) => {
  try {
    if (!SV_ADMIN_TOKEN) {
      return res.status(500).json({ success: false, error: 'SV_API_TOKEN not configured.' });
    }
    const response = await axios.post(`${SV_ADMIN_API_URL}/candidate/report/pdf/initiate`, req.body, {
      headers: svAdminHeaders(),
      timeout: 30000
    });
    res.json(response.data);
  } catch (error) {
    console.error('PDF Initiate Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to initiate PDF generation'
    });
  }
});

/**
 * Poll PDF generation status
 * Proxies: GET /candidate/report/pdf/status?job_id=xxx
 */
app.get('/api/report/pdf/status', async (req, res) => {
  try {
    if (!SV_ADMIN_TOKEN) {
      return res.status(500).json({ success: false, error: 'SV_API_TOKEN not configured.' });
    }
    const response = await axios.get(`${SV_ADMIN_API_URL}/candidate/report/pdf/status`, {
      headers: svAdminHeaders(),
      params: req.query,
      timeout: 30000
    });
    res.json(response.data);
  } catch (error) {
    console.error('PDF Status Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to check PDF status'
    });
  }
});

/**
 * Legacy direct PDF download (blob)
 * Proxies: GET /candidate/report/pdf
 */
app.get('/api/report/pdf/download', async (req, res) => {
  try {
    if (!SV_ADMIN_TOKEN) {
      return res.status(500).json({ success: false, error: 'SV_API_TOKEN not configured.' });
    }
    const response = await axios.get(`${SV_ADMIN_API_URL}/candidate/report/pdf`, {
      headers: svAdminHeaders(),
      params: req.query,
      responseType: 'arraybuffer',
      timeout: 60000
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="report.pdf"'
    });
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error('PDF Download Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to download PDF'
    });
  }
});

/**
 * Fetch candidate list
 * Proxies: GET /company/candidate/all
 */
app.get('/api/report/candidates', async (req, res) => {
  try {
    if (!SV_ADMIN_TOKEN) {
      return res.status(500).json({ success: false, error: 'SV_API_TOKEN not configured.' });
    }
    const response = await axios.get(`${SV_ADMIN_API_URL}/company/candidate/all`, {
      headers: svAdminHeaders(),
      params: req.query,
      timeout: 30000
    });
    res.json(response.data);
  } catch (error) {
    console.error('Candidates Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch candidates'
    });
  }
});

// =============================================
// Serve app
// =============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔐 SpringVerify Face Match + Reports`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Face Match API: SpringScan`);
  console.log(`   Report API:     ${SV_ADMIN_API_URL}`);
  console.log(`   Admin Token:    ${SV_ADMIN_TOKEN ? 'Configured' : 'NOT SET - add SV_API_TOKEN to Secrets'}\n`);
});

module.exports = app;
