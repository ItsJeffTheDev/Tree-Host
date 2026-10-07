# Deploying Tree Host on Render.com

This guide explains how to deploy Tree Host on [Render.com](https://render.com) with Docker support.

## Prerequisites

- A GitHub repository with Tree Host code pushed
- A Render.com account
- Docker knowledge (basic)

## Step 1: Prepare Your Repository

Make sure your repository has:
- `Dockerfile` (included in this repo)
- `render.yaml` (included in this repo)
- `package.json` (already in repo)
- All source code (`src/`, `public/`, etc.)

Push these to your GitHub repo:
```bash
git add Dockerfile render.yaml
git commit -m "Add Render.com deployment configuration"
git push origin main
```

## Step 2: Create a Render Web Service

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New +** → **Web Service**
3. Choose **Deploy existing repository** or connect your GitHub repo
4. Select your Tree Host repository

## Step 3: Configure the Service

### Basic Settings
- **Name**: `tree-host` (or your choice)
- **Region**: Choose closest to your players
- **Branch**: `main` (or your deployment branch)
- **Runtime**: `Docker`

### Environment Variables

Set these in the Render dashboard (Environment section):

| Key | Value | Description |
|-----|-------|-------------|
| `TREEHOST_PUBLIC_URL` | `https://tree-host-xxxx.onrender.com` | Your Render domain |
| `TREEHOST_GAME_HOST` | `tree-host-xxxx.onrender.com` | Domain for game connections |
| `TREEHOST_PORT` | `8766` | Internal port (keep 8766) |
| `TREEHOST_HOST` | `0.0.0.0` | Bind to all interfaces |
| `TREEHOST_ISOLATION` | `auto` | Auto-detect Docker availability |
| `BILLING_DEMO` | `1` | Demo billing (remove for production) |
| `NODE_ENV` | `production` | Production mode |

### Disk Configuration

1. Click **Add Disk**
2. Set:
   - **Name**: `treehost-data`
   - **Mount Path**: `/app/data`
   - **Size**: 50 GB (or as needed)

This disk persists your server worlds and data across restarts.

### Plan Selection

- **Free tier**: Limited resources, suitable for testing
- **Pro**: Recommended for production (more memory, CPU, bandwidth)
- **Pro+**: For high-traffic hosting

## Step 4: Deploy

1. Click **Create Web Service**
2. Render will build and deploy automatically
3. Monitor progress in the **Logs** tab

## Step 5: Verify Deployment

### Check Health

```bash
curl https://your-tree-host-url.onrender.com/api/health
```

Should return `{"ok":true}`.

### Check Logs

In Render dashboard:
- **Build Logs**: Shows Docker build process
- **Deploy Logs**: Shows startup process
- **Live Logs**: Real-time application output

If you see errors, check:
- `Docker is not running` → Make sure Docker socket is available (should be automatic on Render)
- `Could not start: a problem on our side` → Check the full server logs for details

## Step 6: Configure Minecraft Servers

1. Open the Tree Host web interface: `https://your-tree-host-url.onrender.com`
2. Create an account (first account becomes admin)
3. Create a Minecraft server
4. Servers will launch in Docker containers

## Troubleshooting

### Servers won't start

**Issue**: "Failed to launch the server: a problem on our side"

**Solutions**:
1. Check Live Logs in Render dashboard for actual error
2. Verify disk space: `df -h /app/data`
3. Check if Docker image is available: Look for "Downloading Java" in logs
4. Ensure enough memory is allocated (at least 2GB per server)

### High memory usage

**Cause**: Multiple Minecraft servers using too much RAM

**Solutions**:
- Upgrade to Pro plan
- Use separate Render services for different server groups
- Reduce per-server memory allocation
- Restart services periodically

### Persistent storage not working

**Cause**: Disk not properly mounted

**Solutions**:
1. Verify disk mount path is `/app/data`
2. Check disk is not full: Check Render logs
3. Restart the service: Go to Settings → Restart Instance

### Docker fails to spawn containers

**Cause**: Docker socket not available

**Solutions**:
1. This should work automatically on Render
2. If issues persist, check Dockerfile has `docker.io` installed
3. Verify `TREEHOST_ISOLATION=auto` is set

## Environment Variables Reference

### Required (Render.com)
- `TREEHOST_PUBLIC_URL`: Your Render domain
- `TREEHOST_GAME_HOST`: Domain for Minecraft joins
- `TREEHOST_PORT`: 8766

### Optional
- `TREEHOST_ISOLATION`: `auto` (default), `docker`, or `off`
- `TREEHOST_PORTS`: Port range for customer servers (e.g., `25600-25999`)
- `BILLING_DEMO`: `1` for demo billing, `0` for Stripe
- `FIREBASE_SERVICE_ACCOUNT_FILE`: Path to Firebase credentials
- `RESEND_API_KEY`: Email service API key
- `STRIPE_SECRET_KEY`: Stripe API key (requires demo mode off)

## Production Checklist

- [ ] Set up a custom domain (Render Custom Domain)
- [ ] Configure HTTPS (automatic with Render)
- [ ] Set up Firebase authentication
- [ ] Configure Stripe for real payments
- [ ] Enable backups (use Disk snapshots)
- [ ] Monitor resource usage
- [ ] Set up error logging/alerts
- [ ] Test server startup and shutdown cycles
- [ ] Verify world persistence across restarts
- [ ] Document support process for users

## Pricing Notes

- **Free Tier**: One 0.5GB instance, 100GB egress/month, auto-suspends after 15 min inactivity
- **Pro**: Starting $7/month, always on, better resources
- **Disk Storage**: $0.25/GB/month

Multiple servers will require the **Pro plan** for stability.

## Additional Resources

- [Render Docs: Docker](https://render.com/docs/docker)
- [Render Docs: Disks](https://render.com/docs/disks)
- [Tree Host README](../README.md)
- [Tree Host Architecture](../docs/ARCHITECTURE.md)

## Support

For Tree Host-specific issues, join the [Discord server](https://discord.gg/a37pbwajKd).

For Render-specific issues, visit [Render Support](https://render.com/support).
