# SpringVerify Face Match

Identity verification through face matching - compare selfie with ID document photo.

## Quick Start

1. **Import to Replit** - Upload this ZIP file
2. **Click Run** - Works immediately in demo mode
3. **Go Live** - Add API credentials in Secrets tab

## Configuration

Set `API_MODE` in Replit Secrets to switch providers:

### Demo Mode (Default)
No configuration needed. Simulates face matching for testing.

### IDfy
```
API_MODE = idfy
IDFY_API_KEY = your_api_key
IDFY_ACCOUNT_ID = your_account_id
```

### Decentro
```
API_MODE = decentro
DECENTRO_CLIENT_ID = your_client_id
DECENTRO_CLIENT_SECRET = your_client_secret
DECENTRO_MODULE_SECRET = your_module_secret
```

### SpringScan / SVD
```
API_MODE = svd
SVD_TOKEN_KEY = your_token_key
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web application |
| `/api/face-match` | POST | Face match API |
| `/api/health` | GET | Health check |

## Face Match API

**Request:**
```json
POST /api/face-match
{
  "idImage": "base64_encoded_id_image",
  "selfieImage": "base64_encoded_selfie"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "request_id": "REQ_123456",
    "match_score": 92.45,
    "match_band": "HIGH",
    "status": "VERIFIED",
    "confidence_level": "HIGH"
  }
}
```

## Support

Contact: tech@springverify.com
