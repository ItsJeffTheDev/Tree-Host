# Firebase Service Account Setup for Render

Your Tree Host code supports Firebase service account configuration in two ways:
1. **JSON string** (recommended for Render): `FIREBASE_SERVICE_ACCOUNT` environment variable
2. **Individual fields**: `TREEHOST_FIREBASE_*` environment variables

## Option 1: Using FIREBASE_SERVICE_ACCOUNT (Recommended)

### Step 1: Get Service Account JSON
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project: `tree-host`
3. Go to **Project Settings** (gear icon) > **Service Accounts**
4. Click **Generate new private key**
5. Download the JSON file (e.g., `tree-host-firebase-adminsdk-xxxxx.json`)

### Step 2: Convert to Single-Line JSON
Open the JSON file and convert it to a single line (replace newlines with `\n`):

**Original JSON file:**
```json
{
  "type": "service_account",
  "project_id": "tree-host",
  "private_key_id": "xxxxx",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com",
  "client_id": "xxxxx",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-xxxxx%40tree-host.iam.gserviceaccount.com"
}
```

**Single-line version (for Render):**
```json
{"type":"service_account","project_id":"tree-host","private_key_id":"xxxxx","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com","client_id":"xxxxx","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-xxxxx%40tree-host.iam.gserviceaccount.com"}
```

**Quick conversion (Node.js):**
```bash
node -e "console.log(JSON.stringify(require('./tree-host-firebase-adminsdk-xxxxx.json')))"
```

**Quick conversion (Python):**
```bash
python3 -c "import json,sys; print(json.dumps(json.load(open('tree-host-firebase-adminsdk-xxxxx.json'))))"
```

**Quick conversion (online):**
Use a JSON minifier like [jsonminify.com](https://jsonminify.com)

### Step 3: Add to Render
1. Go to your Render service dashboard
2. Navigate to **Environment** tab
3. Add new environment variable:
   - **Key**: `FIREBASE_SERVICE_ACCOUNT`
   - **Value**: Paste the single-line JSON string
4. Click **Save Changes**
5. Trigger a redeploy

### Step 4: Verify
After redeploy, check the logs. You should NOT see:
```
Could not read the Firebase service account: ...
```

## Option 2: Using Individual Fields

If you prefer not to use the JSON string, set these individually in Render:

### Required Fields

**FIREBASE_PROJECT_ID**
```
tree-host
```

**TREEHOST_FIREBASE_CLIENT_EMAIL**
```
firebase-adminsdk-xxxxx@tree-host.iam.gserviceaccount.com
```

**TREEHOST_FIREBASE_PRIVATE_KEY**
This is tricky because it's multiline. In Render's environment variable editor:
1. Key: `TREEHOST_FIREBASE_PRIVATE_KEY`
2. Value: Paste the entire key including BEGIN/END lines
3. Render will handle the multiline format automatically

Example:
```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
...more lines...
-----END PRIVATE KEY-----
```

**TREEHOST_FIREBASE_DATABASE_URL**
```
https://tree-host-default-rtdb.firebaseio.com
```

## Which Option to Use?

**Use Option 1 (FIREBASE_SERVICE_ACCOUNT) if:**
- ✅ You want simpler setup (one variable vs four)
- ✅ You're comfortable with JSON formatting
- ✅ You want to copy-paste from Firebase directly

**Use Option 2 (Individual fields) if:**
- ✅ You want to see each field separately
- ✅ You're troubleshooting which field is wrong
- ✅ You prefer multiline private key handling

## Troubleshooting

### Error: "Could not read the Firebase service account"
- Check that `FIREBASE_SERVICE_ACCOUNT` is valid JSON
- Verify the JSON is a single line (no actual newlines)
- Ensure `\n` in the private_key field are escaped, not actual newlines

### Error: "Firebase login for the server failed"
- Verify the private key is correct
- Check that the client_email matches your Firebase project
- Ensure the service account has proper Firebase permissions

### Error: "Realtime Database failed"
- Verify `FIREBASE_DATABASE_URL` is correct
- Check that the service account has Realtime Database admin permissions
- Ensure `FIREBASE_DB_ROOT` is set (default: `treehost`)

### Authentication not working
- Verify all Firebase config variables are set
- Check that `FIREBASE_API_KEY` matches your Firebase project
- Ensure Email/Password sign-in provider is enabled in Firebase Console

## Testing Locally

To test your Firebase configuration before deploying:

```bash
# Set environment variables
export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
export FIREBASE_API_KEY=REDACTED
export FIREBASE_PROJECT_ID=tree-host
export FIREBASE_DATABASE_URL=https://tree-host-default-rtdb.firebaseio.com

# Test the server
node src/server.js
```

## Security Notes

⚠️ **Important Security Practices:**
- Never commit service account JSON to git
- Never share your private key
- Regularly rotate service account keys
- Use least-privilege access (only grant what's needed)
- Monitor Firebase Console for unusual activity

## Additional Resources

- [Firebase Admin SDK Setup](https://firebase.google.com/docs/admin/setup)
- [Render Environment Variables](https://render.com/docs/environment-variables)
- [Firebase Service Accounts](https://cloud.google.com/iam/docs/service-accounts)
