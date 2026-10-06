# Fix for "Keeps Asking for Username and Birth Year After Redeploy"

## Problem

When Render redeploys, users get logged out and are asked to re-enter their username and birth year, even though they already completed onboarding.

## Root Cause

**Firebase is not properly configured** on Render, so:
1. User data is only saved locally (in `/tmp/treehost`)
2. Render redeploys wipe all local data
3. User accounts exist in Firebase but the sync is broken
4. When you sign in, the server can't find your data and asks for onboarding again

## What I Fixed

### 1. Client-Side Fallback (team.js)

Added localStorage to remember onboarding data as a temporary workaround:

**What it does:**
- Saves username and birth year to browser localStorage when you sign up
- Auto-fills these values when you're asked for them again
- Clears saved data after successful login/profile completion

**Modified files:**
- `public/team.js` - Added localStorage fallback for both Firebase and local auth

**Storage keys:**
- `th_onboarding_username` - Saved username
- `th_onboarding_birth_year` - Saved birth year

### 2. Better Error Messages (store.js)

Enhanced Firebase sync error logging to help diagnose issues:

**What it does:**
- Logs clear warnings when Firebase is not enabled
- Shows helpful error messages when Firebase writes fail
- Points to debugging documentation

**Modified files:**
- `src/store.js` - Enhanced error logging in `load()` and `flush()`

**Example warnings:**
```
⚠️  Firebase not enabled: team-users loaded from local file only.
⚠️  Data will be lost on redeploy. Set FIREBASE_SERVICE_ACCOUNT to enable Firebase sync.
```

### 3. Firebase Debugging Guide

Created comprehensive debugging documentation:

**File:** `FIREBASE_DEBUGGING.md`

**Includes:**
- Root cause explanation
- Configuration checklist
- Step-by-step debugging
- Common mistakes
- Verification steps
- Test scripts

## The Real Fix

The localStorage fallback is **NOT a permanent solution**. You need to:

### Step 1: Configure Firebase on Render

Add these environment variables in Render:

```bash
# Enable Firebase sync
TREEHOST_TEAM=1

# Firebase service account (REQUIRED for database writes)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"tree-host","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com",...}

# OR use individual fields:
TREEHOST_FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com
TREEHOST_FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

See `RENDER_FIREBASE_SETUP.md` for detailed instructions.

### Step 2: Verify Configuration

1. Redeploy your Render service
2. Check Render logs for Firebase errors
3. Check Firebase Console > Realtime Database
4. You should see `team-users` with your account data

### Step 3: Test

1. Sign up for a new account
2. Enter username and birth year
3. Verify data appears in Firebase Console
4. Redeploy again
5. Sign in - should NOT ask for username/birth year

## How to Verify Firebase is Working

### Check Render Logs

**Good signs:**
```
Uploading team-users to the Firebase Realtime Database...
```

**Bad signs:**
```
⚠️  Firebase not enabled: team-users loaded from local file only.
⚠️  Could not save team-users to Firebase: ...
```

### Check Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project: `tree-host`
3. Go to Realtime Database
4. Look for `treehost` node
5. You should see: `team-users`, `team-invites`, `team-resets`, `team-settings`

### Check Browser Console

Open DevTools (F12) > Console:

**Good:** No Firebase errors
**Bad:**
```
Firebase: Error (auth/invalid-api-key)
Firebase: Error (auth/unauthorized-domain)
```

## Common Mistakes

### ❌ Mistake 1: Missing FIREBASE_SERVICE_ACCOUNT

Without this, the server cannot write to Firebase.

**Fix:** Add the service account JSON as an environment variable.

### ❌ Mistake 2: Private key has actual newlines

```bash
# WRONG (has actual newlines)
TREEHOST_FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----"

# CORRECT (uses \n for newlines)
TREEHOST_FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
```

### ❌ Mistake 3: Missing TREEHOST_TEAM

Without this, Firebase sync is disabled.

**Fix:** Set `TREEHOST_TEAM=1`

### ❌ Mistake 4: Firebase Database rules block writes

Go to Firebase Console > Realtime Database > Rules:

**Should allow writes:**
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

## Temporary vs Permanent

### Temporary Workaround (What I Added)
✅ Saves onboarding data to localStorage
✅ Auto-fills when asked again
✅ Helps during Firebase sync issues
❌ Not a replacement for Firebase
❌ Data only saved in browser (not across devices)

### Permanent Solution (What You Need)
✅ Firebase configured correctly
✅ Data saved to cloud database
✅ Persists across redeploys
✅ Works across devices
❌ Requires proper configuration

## Summary

**What I did:**
1. ✅ Added localStorage fallback for onboarding data
2. ✅ Enhanced error logging for Firebase issues
3. ✅ Created comprehensive debugging guide

**What you need to do:**
1. ⚠️ Configure `FIREBASE_SERVICE_ACCOUNT` in Render
2. ⚠️ Set `TREEHOST_TEAM=1`
3. ⚠️ Verify Firebase Console shows your data
4. ⚠️ Check Render logs for errors

**The localStorage fallback will help** while you fix Firebase, but it's not a permanent solution. Configure Firebase properly to ensure data persists across redeploys.

## Files Modified

- `public/team.js` - Added localStorage fallback for onboarding data
- `src/store.js` - Enhanced error logging for Firebase sync issues
- `FIREBASE_DEBUGGING.md` - New debugging guide

## Related Documentation

- `RENDER_FIREBASE_SETUP.md` - How to configure Firebase service account
- `FIREBASE_DEBUGGING.md` - Debugging Firebase issues
- `SESSION_PERSISTENCE_SUMMARY.md` - How session persistence works
