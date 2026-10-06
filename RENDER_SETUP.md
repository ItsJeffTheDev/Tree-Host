# Tree Host on Render.com

This guide explains how to deploy Tree Host to Render.com, including important limitations of the free tier for Minecraft server hosting.

## ⚠️ Important: Free Tier Limitations

Render's free tier has significant limitations that affect Minecraft server hosting:

### Free Tier Limitations
- **Spin-down**: Services sleep after 15 minutes of inactivity (takes ~30 seconds to wake up)
- **Ephemeral storage**: All data is lost on redeploy/restart
- **No Docker services**: Cannot run isolated Minecraft server containers
- **512MB RAM**: Insufficient for most Minecraft servers
- **No background workers**: Cannot run persistent MC server processes
- **No persistent disk**: Server worlds are not saved

### What Works on Free Tier
- ✅ Web interface and dashboard
- ✅ User authentication (with Firebase)
- ✅ Account management
- ✅ Billing interface (if you configure Stripe)
- ✅ Server configuration UI
- ❌ **Actual Minecraft server execution** (requires paid tier or alternative)

### Recommended for Production
To actually run Minecraft servers, you need:
1. **Render Starter ($7/mo)** with persistent disk addon
2. **Alternative platforms**: Railway, Fly.io, or a VPS (DigitalOcean, Linode, Hetzner)
3. **Dedicated MC hosting**: Apex, MCProHosting, etc.

## Prerequisites

1. **Render account**: [sign up at render.com](https://render.com)
2. **GitHub repository**: Push your Tree Host code to GitHub
3. **Firebase project**: For authentication and database
4. **Domain** (optional): For custom domain
5. **Email service** (optional): Resend for sending emails

## Step 1: Set Up Firebase

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project or use existing
3. Enable **Authentication** (Email/Password provider)
4. Enable **Realtime Database** (set rules for production)
5. Go to Project Settings > Service Accounts
6. Generate a new private key
7. Download the JSON file - you'll need these values:
   - `project_id`
   - `client_email`
   - `private_key` (full multiline key)
   - `database_url` (from Realtime Database section)

## Step 2: Deploy to Render

### Option A: Using render.yaml (Recommended)

1. Push your code to GitHub (including `render.yaml`)
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New +" > "Blueprint"
4. Connect your GitHub repository
5. Render will detect `render.yaml` and show the configuration
6. Review and click "Apply"

### Option B: Manual Setup

1. Go to Render Dashboard > "New +" > "Web Service"
2. Connect your GitHub repository
3. Configure:
   - **Name**: tree-host-web
   - **Region**: Choose closest to users
   - **Branch**: main
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node src/server.js`
   - **Instance Type**: Free (or Starter for production)

## Step 3: Configure Environment Variables

In your Render service settings, add these environment variables:

### Required for Basic Functionality
```
NODE_ENV=production
PORT=8080
TREEHOST_HOST=0.0.0.0
TREEHOST_PORT=8080
TREEHOST_DATA=/tmp/treehost
TREEHOST_ISOLATION=off
TREEHOST_TRUST_PROXY=1
TREEHOST_TEAM=1
TREEHOST_STAGING=1
TREEHOST_PUBLIC_URL=https://your-service.onrender.com
```

### Required for Firebase (Authentication/Database)
```
TREEHOST_FIREBASE_PROJECT_ID=your-project-id
TREEHOST_FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
TREEHOST_FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
TREEHOST_FIREBASE_DATABASE_URL=https://your-project.firebaseio.com
```

**Important**: The private key must be formatted as a single line with `\n` for newlines, or use Render's multiline editor.

### Optional: Email Service (Resend)
```
TREEHOST_RESEND_API_KEY=re_xxxxxxxxxxxx
```

Get API key from [resend.com](https://resend.com)

### Optional: Stripe (Billing)
```
TREEHOST_STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxx
TREEHOST_STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
TREEHOST_STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxx
```

### Optional: Custom Configuration
```
TREEHOST_DISCORD_INVITE=https://discord.gg/your-invite
TREEHOST_SUPPORT_EMAIL=support@yourdomain.com
TREEHOST_BILLING_EMAIL=billing@yourdomain.com
TREEHOST_PROMO_EMAIL=promo@yourdomain.com
TREEHOST_DMCA_EMAIL=dmca@yourdomain.com
TREEHOST_MAX_BACKUPS=5
TREEHOST_BLOCKED_COUNTRIES=CU,IR,KP,SY
```

## Step 4: Update Public URL

After deployment:
1. Note your Render service URL (e.g., `https://tree-host-web.onrender.com`)
2. Update `TREEHOST_PUBLIC_URL` environment variable with this URL
3. Redeploy (or wait for automatic redeploy)

## Step 5: Disable Staging Mode (When Ready)

To allow server creation and purchases:
1. Set `TREEHOST_STAGING=0` or remove the variable
2. Redeploy

## Step 6: Configure Custom Domain (Optional)

1. In Render service settings, go to "Domains"
2. Add your custom domain (e.g., `treehost.yourdomain.com`)
3. Update DNS records as instructed by Render
4. Update `TREEHOST_PUBLIC_URL` to your custom domain
5. Redeploy

## Running Minecraft Servers on Render

### Option 1: Render Starter with Persistent Disk
For the Starter plan ($7/mo):
1. Add a persistent disk (e.g., 10GB)
2. Update `TREEHOST_DATA` to point to the disk mount
3. Set `TREEHOST_ISOLATION=docker` (if Docker available)
4. Note: MC servers still sleep on spin-down - you may need a background worker

### Option 2: Separate MC Server Infrastructure
Recommended architecture:
- **Render**: Web app, dashboard, billing, auth
- **Railway/Fly.io/VPS**: Actual MC server instances
- Configure Tree Host to manage remote MC servers via API

### Option 3: Render Background Worker
Create a separate worker service to keep MC servers running:
```yaml
# Add to render.yaml
  - type: worker
    name: tree-host-worker
    env: node
    plan: starter  # Workers need non-free plan
    startCommand: node src/worker.js  # You'll need to create this
```

## Troubleshooting

### Service won't start
- Check Render logs for errors
- Verify all environment variables are set
- Ensure `NODE_ENV=production`

### Authentication failing
- Verify Firebase credentials are correct
- Check Firebase Realtime Database rules
- Ensure `TREEHOST_PUBLIC_URL` matches your service URL

### Data lost on redeploy
- This is expected on free tier (ephemeral storage)
- Upgrade to Starter with persistent disk
- Or implement external storage (Firebase, S3)

### Minecraft servers not starting
- Free tier doesn't support Docker or persistent processes
- Upgrade to Starter plan
- Or use separate infrastructure for MC servers

## Cost Estimates

### Render Free Tier
- $0/month
- Web service only (no MC servers)
- Spin-down after 15min inactivity

### Render Starter (Recommended for Production)
- $7/month for web service
- ~$2-10/month for persistent disk (depending on size)
- ~$7/month for background worker (if needed)
- **Total**: ~$16-24/month for basic setup

### Alternative: VPS (DigitalOcean/Linode)
- $4-6/month for basic VPS
- Full control, can run Docker
- Can host both web app and MC servers
- More complex setup

## Monitoring

- Render provides built-in metrics (CPU, memory, response time)
- Check logs in Render dashboard
- Set up alerts for high error rates or spin-down events

## Security

- Keep environment variables secret
- Use Firebase security rules
- Enable HTTPS (automatic on Render)
- Consider Cloudflare for DDoS protection
- Regularly update dependencies

## Support

- Render docs: [docs.render.com](https://docs.render.com)
- Firebase docs: [firebase.google.com/docs](https://firebase.google.com/docs)
- Tree Host issues: Check project issues or documentation
