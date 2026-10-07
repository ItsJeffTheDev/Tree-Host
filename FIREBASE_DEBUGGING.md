# Firebase Debugging Guide for Render Deployment

## Problem: "Keeps asking for username and birth year after redeploy"

This happens when Firebase is not properly configured, so user data is only saved locally (which gets wiped on Render redeploy).

## Root Cause

When Render redeploys:
1. **Local storage is wiped** - All files in `/tmp` are lost
2. **Sessions are lost** - If Firebase isn't saving to the database
3. **User data is lost** - Username, birth year, etc. are not persisted

## Solution Checklist

### 1. Verify Firebase is Configured

**Check these environment variables in Render:**

```bash
# Required for Firebase to work
TREEHOST_TEAM=1
FIREBASE_PROJECT_ID=tree-host
FIREBASE_DATABASE_URL=https://tree-host-default-rtdb.firebaseio.com

# Firebase web config (public)
FIREBASE_API_KEY=REDACTED
FIREBASE_AUTH_DOMAIN=tree-host.firebaseapp.com
FIREBASE_APP_ID=1:840029330018:web:96c8dbdde3990b3fdccf3b

# Firebase service account (SECRET - required for database writes)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
# OR individual fields:
TREEHOST_FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com
TREEHOST_FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

### 2. Test Firebase Connection

**Check server logs for these messages:**

✅ **Good signs:**
```
Uploading team-users to the Firebase Realtime Database...
```
(Only appears once on first sync)

❌ **Bad signs:**
```
Could not read the Firebase service account: ...
Could not save team-users to Firebase: ...
```

**How to check logs:**
1. Go to Render dashboard
2. Click your service
3. Click "Logs" tab
4. Look for Firebase-related errors

### 3. Verify Firebase Database Rules

Go to [Firebase Console](https://console.firebase.google.com) > Realtime Database > Rules:

**Required rules (for admin access):**
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Or for production (more secure):
```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

### 4. Check Firebase Console

**Verify data is being saved:**
1. Go to Firebase Console > Realtime Database
2. Look for `treehost` node (or your `FIREBASE_DB_ROOT`)
3. You should see:
   - `team-users`
   - `team-invites`
   - `team-resets`
   - `team-settings`

**If you see NO data:**
- Firebase is not configured correctly
- Service account key is invalid
- Database rules are blocking writes

### 5. Test Service Account Key

**Verify your service account JSON is valid:**

```bash
# Save your service account JSON to a file
# Then test it:
node -e "console.log(JSON.parse(require('fs').readFileSync('service-account.json')).project_id)"
```

Should output: `tree-host`

**Common issues:**
- ❌ JSON has extra whitespace or newlines
- ❌ Private key has actual newlines instead of `\n`
- ❌ Missing required fields
- ❌ Wrong project ID

### 6. Verify Client-Side Firebase Config

**Check browser console for Firebase errors:**

Open browser DevTools (F12) > Console:

✅ **Good:** No Firebase errors
❌ **Bad:**
```
Firebase: No Firebase App '[DEFAULT]' has been created
Firebase: Error (auth/invalid-api-key)
Firebase: Error (auth/unauthorized-domain)
```

**How to check client config:**
1. Open your site in browser
2. Open DevTools > Console
3. Type: `window.firebaseConfig`
4. Should see your Firebase config object

## Temporary Workaround (Added)

I've added a **client-side fallback** that saves onboarding data to localStorage:

**What it does:**
- Saves username and birth year to browser localStorage
- Auto-fills these values on next login attempt
- Clears saved data after successful login

**This helps when:**
- Firebase sync is temporarily down
- Render redeploy wipes local data
- User needs to re-enter onboarding data

**Note:** This is a fallback, not a replacement for proper Firebase configuration.

## Fix Steps

### Step 1: Check Render Environment Variables

1. Go to Render dashboard > Your service > Environment
2. Verify ALL required variables are set
3. Check for typos (especially in FIREBASE_SERVICE_ACCOUNT)

### Step 2: Regenerate Service Account Key

If the key might be corrupted:

1. Go to Firebase Console > Project Settings > Service Accounts
2. Generate new private key
3. Download the JSON
4. Convert to single-line (see RENDER_FIREBASE_SETUP.md)
5. Update `FIREBASE_SERVICE_ACCOUNT` in Render
6. Redeploy

### Step 3: Test Database Access

Create a simple test script:

```javascript
// test-firebase.js
const firebase = require('./src/firebase');

async function test() {
  console.log('Auth enabled:', firebase.authEnabled());
  console.log('DB enabled:', firebase.dbEnabled());

  if (firebase.dbEnabled()) {
    try {
      await firebase.dbSet('test', { timestamp: Date.now() });
      console.log('✅ Write successful');
      const data = await firebase.dbGet('test');
      console.log('✅ Read successful:', data);
    } catch (e) {
      console.log('❌ Database error:', e.message);
    }
  }
}

test();
```

Run: `node test-firebase.js`

### Step 4: Check for Common Mistakes

**❌ Mistake 1: Using file path instead of JSON string**
```
FIREBASE_SERVICE_ACCOUNT=/etc/secrets/firebase.json  # WRONG
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}  # CORRECT
```

**❌ Mistake 2: Private key has actual newlines**
```
TREEHOST_FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----"  # WRONG (has actual newlines)
```

**✅ Correct:**
```
TREEHOST_FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"  # CORRECT (\n for newlines)
```

**❌ Mistake 3: Missing TREEHOST_TEAM**
```
# Without this, Firebase sync is disabled
```

**✅ Correct:**
```
TREEHOST_TEAM=1  # Enables Firebase sync
```

## Verification

### After fixing, verify it works:

1. **Redeploy** your Render service
2. **Sign up** for a new account
3. **Enter username and birth year**
4. **Check Firebase Console** - you should see the user in `team-users`
5. **Redeploy again**
6. **Sign in** - should NOT ask for username/birth year again

### If it still asks for username/birth year:

1. Check Render logs for Firebase errors
2. Check Firebase Console for user data
3. Check browser console for client errors
4. Verify all environment variables are correct
5. Try the test script above

## Advanced Debugging

### Enable Debug Logging

Add to render.yaml temporarily:
```yaml
envVars:
  - key: NODE_ENV
    value: development  # More verbose logging
```

### Check Network Requests

In browser DevTools > Network:
1. Filter by XHR/Fetch
2. Look for requests to `firebaseio.com`
3. Check response codes (should be 200)
4. Check for authentication errors

### Monitor Firebase Usage

Go to Firebase Console > Usage:
- Check if requests are being made
- Check for authentication failures
- Check database read/write counts

## Still Having Issues?

### Quick diagnostic questions:

1. **Is `TREEHOST_TEAM=1` set?**
   - If no: Firebase sync is disabled

2. **Is `FIREBASE_SERVICE_ACCOUNT` set?**
   - If no: Cannot write to database

3. **Do you see data in Firebase Console?**
   - If no: Firebase writes are failing

4. **Do you see errors in Render logs?**
   - If yes: Check the error message

5. **Do you see errors in browser console?**
   - If yes: Client-side Firebase config issue

## Summary

**The fix:**
1. ✅ Add `FIREBASE_SERVICE_ACCOUNT` (or individual fields)
2. ✅ Set `TREEHOST_TEAM=1`
3. ✅ Verify Firebase Database rules allow writes
4. ✅ Check Render logs for errors
5. ✅ Verify data appears in Firebase Console

**Temporary workaround:**
- ✅ Client-side localStorage fallback (already added)
- Auto-fills saved username/birth year
- Helps during Firebase sync issues

**Remember:** The localStorage fallback is helpful but NOT a replacement for proper Firebase configuration. Fix Firebase to ensure data persists across redeploys.
