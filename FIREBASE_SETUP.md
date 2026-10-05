# Firebase Setup for Render Deployment

## Overview

Tree Host uses Firebase for:
1. **Authentication** - Email/password and Google sign-in
2. **Realtime Database** - Storing users, servers, and configuration
3. **Auth Admin API** - Managing user accounts

## Step 1: Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **"Create a project"**
   - Name: `tree-host` (or your preference)
   - Enable Google Analytics (optional)
3. Click **"Create project"**

## Step 2: Get the Web Config

1. In Firebase Console, go to **Project Settings** (gear icon)
2. Scroll to **"Your apps"** section
3. If no web app exists, click **"</> Web"** to add one
   - App nickname: `Tree Host Web`
4. Copy these values:
   ```
   FIREBASE_API_KEY = apiKey
   FIREBASE_AUTH_DOMAIN = authDomain
   FIREBASE_PROJECT_ID = projectId
   FIREBASE_DATABASE_URL = databaseURL
   FIREBASE_APP_ID = appId
   ```

## Step 3: Enable Authentication

1. Go to **Authentication** → **Sign-in method**
2. Enable these providers:
   - ✅ **Email/Password** (Email-password authentication)
   - ✅ **Google** (requires a Google OAuth 2.0 credential)
3. For Google:
   - Click **"Google"** → **"Enable"**
   - Add authorized domains: `localhost:8766`, `tree-host.onrender.com`

## Step 4: Enable Realtime Database

1. Go to **Realtime Database**
2. Click **"Create Database"**
   - Location: closest to your Render server (e.g., us-central1)
   - Security rules: start in **Test mode** for development (allow all reads/writes)
3. Copy the database URL: `https://YOUR_PROJECT-default-rtdb.firebaseio.com`

## Step 5: Create a Service Account (for server access)

1. Go to **Project Settings** → **Service Accounts**
2. Click **"Generate New Private Key"**
3. Save the JSON file (keep it SECRET)
4. In Render:
   - Create a secret file with this JSON
   - Set `FIREBASE_SERVICE_ACCOUNT_FILE=/etc/secrets/firebase-service-account.json`

## Step 6: Set Security Rules (Production)

In **Realtime Database** → **Rules**, replace with:

```json
{
  "rules": {
    "treehost": {
      ".read": "root.child('users').child(auth.uid).exists()",
      ".write": "root.child('users').child(auth.uid).exists()",
      "users": {
        "$uid": {
          ".read": "auth.uid === $uid",
          ".write": "auth.uid === $uid"
        }
      }
    }
  }
}
```

## Step 7: Configure Render Environment

Add these environment variables in Render Web Service settings:

```
FIREBASE_API_KEY=REDACTED
FIREBASE_AUTH_DOMAIN=tree-host.firebaseapp.com
FIREBASE_DATABASE_URL=https://tree-host-default-rtdb.firebaseio.com
FIREBASE_PROJECT_ID=tree-host
FIREBASE_APP_ID=1:840029330018:web:96c8dbdde3990b3fdccf3b
TREEHOST_PUBLIC_URL=https://tree-host.onrender.com
TREEHOST_HOST=0.0.0.0
TREEHOST_PORT=8080
TREEHOST_TRUST_PROXY=1
TREEHOST_TEAM=1
TREEHOST_DATA=/tmp/treehost
TREEHOST_ISOLATION=off
TREEHOST_ADMIN_EMAILS=your-email@gmail.com
```

### Add Service Account Secret File

1. In Render: **Web Service** → **Environment** → **Secret Files**
2. Click **"Add Secret File"**
   - Filename: `firebase-service-account.json`
   - Contents: Paste the entire JSON from Step 5
3. Set environment variable:
   ```
   FIREBASE_SERVICE_ACCOUNT_FILE=/etc/secrets/firebase-service-account.json
   ```

## Step 8: Test the Deployment

1. Deploy to Render
2. Visit `https://tree-host.onrender.com/`
3. Click **"Sign in"** → **"Create account"**
4. Use an email matching `TREEHOST_ADMIN_EMAILS` to become **Owner**
5. Other emails become **customers**

## Troubleshooting

### "Sign-in form not showing"
- ✅ Check `FIREBASE_API_KEY` is set
- ✅ Check `tree-host.onrender.com` is in Firebase authorized domains

### "Can't store data in database"
- ✅ Check `FIREBASE_SERVICE_ACCOUNT_FILE` path is correct
- ✅ Verify service account JSON has `private_key` field
- ✅ Check Realtime Database security rules allow writes

### "Users not becoming Owner"
- ✅ Make sure email is verified in Firebase
- ✅ Email must exactly match `TREEHOST_ADMIN_EMAILS`

## Files Changed

- `.render-env-template` - Copy this to your Render environment
- `FIREBASE_SETUP.md` - This guide
- `src/firebase.js` - Already configured (no changes needed)
- `src/auth.js` - Already configured (no changes needed)
