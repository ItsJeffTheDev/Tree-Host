# Session Persistence & Firebase Database Configuration

## ✅ What's Already Working

### 1. Session Persistence (Keep Users Logged In)

Your Tree Host already has robust session persistence built in:

**Server-Side (src/auth.js):**
- Sessions are stored with a **30-day TTL** (30 * 86400000 ms)
- Sessions are saved to Firebase Realtime Database when `TREEHOST_TEAM=1`
- Session token is stored in an HTTP-only cookie (`th_session`)
- Cookie is marked with `Secure` when using HTTPS, `HttpOnly` for security, and `SameSite=Strict`

**Client-Side (public/team.js):**
- Firebase Auth integration handles client-side authentication
- Account switcher stores multiple session tokens in cookies
- Device tracking links accounts used together

**How it works:**
1. User signs in → Server creates session token (30-day expiry)
2. Token stored in HTTP-only cookie + Firebase Database
3. On page load, server validates token from cookie
4. If valid, user stays logged in automatically
5. Sessions persist across browser restarts (cookies)

**Cookie Configuration (src/server.js):**
```javascript
SESSION_COOKIE = 'th_session'
Max-Age: 30 days
HttpOnly: Yes (prevents XSS)
SameSite: Strict (prevents CSRF)
Secure: Yes (when on HTTPS)
```

### 2. Firebase Database Saving

Your application automatically saves data to Firebase Realtime Database when configured:

**What Gets Saved to Firebase:**
- User accounts (`team-users`)
- Staff invites (`team-invites`)
- Password resets (`team-resets`)
- Settings (`team-settings`)
- Subscriptions and billing data
- Server instances
- Activity logs
- Moderation actions

**How It Works (src/store.js):**
1. **Load**: On startup, loads from Firebase (if available) with local backup
2. **Save**: Every write goes to both local file AND Firebase
3. **Sync**: Firebase is the source of truth when enabled
4. **Fallback**: If Firebase is down, uses local copy
5. **Migration**: Local-only data uploads to Firebase on first run

**Automatic Sync:**
- Writes are batched (multiple quick saves = one DB write)
- Retries up to 3 times with exponential backoff
- Local files always kept as backup
- Console logs any Firebase sync errors

### 3. Multi-Account Support

Your app supports multiple accounts in one browser:
- `th_session`: Active account token
- `th_accounts`: All signed-in accounts (up to 5)
- `th_device`: Browser identifier (links accounts together)
- Account switcher in dashboard

## ✅ What I Added

### Navigation: Click Brand to Go Home

I made the "Tree Host" brand clickable in all pages to navigate back to the home page:

**Updated Files:**
1. **public/dashboard.html** - Dashboard sidebar brand
2. **public/console.js** - Staff Console brand
3. **public/moderation.js** - Restricted account page brand

**Changes:**
- Changed `<div class="brand">` to `<a href="/" class="brand">`
- Added `style="text-decoration:none;color:inherit"` to maintain appearance
- Now clicking "Tree Host" anywhere takes you to the home page

## Configuration Requirements

### For Session Persistence to Work with Firebase

**Environment Variables Needed:**
```
TREEHOST_TEAM=1  # Enables team/accounts mode
TREEHOST_PUBLIC_URL=https://your-domain.com  # Your public URL
```

**Firebase Configuration (Required):**
```
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}  # OR individual fields
FIREBASE_PROJECT_ID=tree-host
FIREBASE_DATABASE_URL=https://tree-host-default-rtdb.firebaseio.com
```

**Firebase Web Config (Public):**
```
FIREBASE_API_KEY=REDACTED
FIREBASE_AUTH_DOMAIN=tree-host.firebaseapp.com
FIREBASE_APP_ID=1:840029330018:web:96c8dbdde3990b3fdccf3b
```

### For Firebase Database Saving

**Requirements:**
1. Firebase Realtime Database enabled
2. Service account with proper permissions
3. `TREEHOST_TEAM=1` (enables Firebase sync)
4. Service account key configured

**What Happens Without Firebase:**
- Sessions still work (local file storage)
- Data saved to local JSON files only
- No persistence across server restarts/deployments
- Lost data if server is redeployed (like on Render free tier)

## Testing Session Persistence

### Test 1: Sign In and Stay Logged In
1. Sign in to your account
2. Close the browser tab
3. Open the site again
4. ✅ You should still be logged in

### Test 2: Data Persists to Firebase
1. Create a server or change settings
2. Check Firebase Console > Realtime Database
3. ✅ You should see the data in the database

### Test 3: Cross-Device Sync
1. Sign in on Device A
2. Sign in on Device B with same account
3. ✅ Changes on A should appear on B (via Firebase)

### Test 4: Session Expiry
1. Sign in
2. Wait 30 days (or test by reducing SESSION_TTL in code)
3. ⚠️ Session expires and you need to sign in again

## Render Deployment Notes

### Session Persistence on Render
- ✅ Works with Firebase configuration
- ✅ Sessions stored in Firebase (survives redeploys)
- ⚠️ Local file storage lost on redeploy (use Firebase)

### Database Persistence on Render
- ✅ Firebase Realtime Database works perfectly
- ✅ Data survives Render redeploys
- ✅ Works across multiple Render instances
- ⚠️ Must configure `FIREBASE_SERVICE_ACCOUNT`

### Required for Render
```yaml
# In render.yaml
envVars:
  - key: TREEHOST_TEAM
    value: "1"
  - key: FIREBASE_SERVICE_ACCOUNT
    sync: false  # Set in dashboard
```

## Troubleshooting

### "Please sign in" keeps appearing
- Check that `TREEHOST_TEAM=1` is set
- Verify Firebase service account is configured
- Check browser console for Firebase errors
- Ensure cookies are enabled in browser

### Data not saving to Firebase
- Verify `FIREBASE_SERVICE_ACCOUNT` is valid JSON
- Check Firebase Console > Realtime Database rules
- Ensure service account has admin permissions
- Check server logs for Firebase sync errors

### Sessions lost on redeploy
- Ensure Firebase is configured and enabled
- Check that data is visible in Firebase Console
- Verify `TREEHOST_TEAM=1` is set
- Local file storage is expected to be lost on Render

## Summary

Your Tree Host application is **already fully configured** for:
- ✅ 30-day session persistence
- ✅ Firebase Realtime Database sync
- ✅ Multi-account support
- ✅ Cross-device sync

**What I added:**
- ✅ Clickable "Tree Host" brand to navigate home

**What you need to do:**
- Configure `FIREBASE_SERVICE_ACCOUNT` in Render
- Ensure `TREEHOST_TEAM=1` is set
- Deploy and test

The session persistence and Firebase saving are **built-in features** that just need proper configuration to work!
