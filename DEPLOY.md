# Quick Deploy to Render.com

Fastest way to get Tree Host running on Render.com with your existing configuration.

## Prerequisites
- GitHub account with Tree Host code pushed
- Render account (free at render.com)
- Firebase project: `tree-host` (already configured)
- Firebase service account key (get from Firebase Console)

## 5-Minute Deployment

### 1. Push Code to GitHub
```bash
git add .
git commit -m "Add Render deployment config"
git push origin main
```

### 2. Get Firebase Service Account Key (3 min)
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select project: `tree-host`
3. Project Settings > Service Accounts > Generate new private key
4. Download the JSON file
5. Convert to single-line JSON (see [RENDER_FIREBASE_SETUP.md](RENDER_FIREBASE_SETUP.md))

### 3. Deploy to Render (2 min)
1. Go to [render.com](https://render.com) > New + > Blueprint
2. Connect your GitHub repo
3. Render detects `render.yaml` automatically
4. Click "Apply"

### 4. Add Firebase Service Account (2 min)
In Render service settings > Environment:

**Option A (Recommended): Single JSON string**
```
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"tree-host",...}
```
Paste your entire service account JSON as a single line.

**Option B: Individual fields**
```
TREEHOST_FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com
TREEHOST_FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

See [RENDER_FIREBASE_SETUP.md](RENDER_FIREBASE_SETUP.md) for detailed instructions.

### 5. Update Public URL (1 min)
After deployment completes:
1. Note your service URL: `https://tree-host-web.onrender.com`
2. Update `TREEHOST_PUBLIC_URL` environment variable to match
3. Redeploy

### 6. Launch!
- Wait for build (~2-3 min)
- Visit: `https://tree-host-web.onrender.com`
- Sign up and test

## Your Pre-Configured Settings

Your `render.yaml` already includes:
- ✅ Firebase web config (API key, project ID, etc.)
- ✅ Stripe test keys for billing
- ✅ Tree Host configuration (team mode, proxy, etc.)
- ✅ Staging mode enabled (disable when ready)

**Just add:** Firebase service account key

## Important Notes

⚠️ **Free Tier Limitations:**
- Web dashboard works fine
- Minecraft servers won't actually run (need paid tier or separate infrastructure)
- Data lost on redeploy
- Service sleeps after 15min inactivity

💡 **For Production:**
- Upgrade to Render Starter ($7/mo) + persistent disk
- Or use a VPS (DigitalOcean $5/mo) for MC servers
- Or use dedicated MC hosting

## Next Steps

1. ✅ Deploy and test the web interface
2. Configure email (Resend) for user emails
3. Test Stripe billing (test mode is configured)
4. Consider custom domain
5. Disable staging mode when ready (`TREEHOST_STAGING=0`)

## Documentation

- [RENDER_SETUP.md](RENDER_SETUP.md) - Full setup guide
- [RENDER_FIREBASE_SETUP.md](RENDER_FIREBASE_SETUP.md) - Firebase configuration
- [FREE_TIER_LIMITATIONS.md](FREE_TIER_LIMITATIONS.md) - Platform limitations
