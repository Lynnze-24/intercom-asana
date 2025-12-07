# Quick Setup Guide

## Step 1: Update Your Workspace ID

1. Open `src/public/index.html`
2. Find line 37: `const WORKSPACE_ID = 'YOUR-WORKSPACE-ID';`
3. Replace `YOUR-WORKSPACE-ID` with your Intercom workspace ID
   - Find it in your Intercom URL: `https://app.intercom.com/a/apps/YOUR-WORKSPACE-ID`

## Step 2: Start the Server

```bash
yarn dev
```

The server will start at `http://localhost:3000`

## Step 3: Expose Your Local Server

Choose one of these options:

### Option A: Using ngrok (Recommended)
```bash
ngrok http 3000
```

### Option B: Using localtunnel
```bash
npx localtunnel --port 3000
```

Copy the public URL (e.g., `https://abc123.ngrok.io`)

## Step 4: Create Your Intercom App

1. Go to [Intercom Developer Hub](https://app.intercom.com/a/apps/_/developer-hub)
2. Click **New app**
3. Name your app (e.g., "Department Tracker")
4. Click **Create app**

## Step 5: Configure Canvas Kit

1. In your new app, click **Canvas Kit** in the sidebar
2. Click **For teammates**
3. Check **Add to conversation details**
4. Add your endpoints:
   - **Initialize URL**: `https://your-public-url.com/initialize`
   - **Submit URL**: `https://your-public-url.com/submit`
5. Click **Save**
6. Toggle the switch to **On**

## Step 6: Test Your App

### Create a Test Conversation:
1. Visit your public URL (e.g., `https://abc123.ngrok.io`)
2. Click the Messenger widget in the bottom right
3. Send a test message

### Add App to Inbox:
1. Go to your Intercom Inbox
2. Open the test conversation
3. Click **Edit Apps** in the right panel
4. Pin your app
5. Click to expand your app

### Test the Flow:
1. Select a department (Sales, Operations, or Engineering)
2. Click **Submit**
3. You should see "You chose: [department]"
4. Click **Submit another** to restart

## Troubleshooting

### ❌ App not showing in Inbox
- Verify URLs are publicly accessible
- Check Canvas Kit is toggled **On**
- Restart your Intercom app

### ❌ Messenger not loading
- Verify workspace ID is correct in `index.html`
- Check browser console for errors

### ❌ Submit not working
- Check server logs in terminal
- Verify `/submit` endpoint is accessible
- Test endpoints with curl:
  ```bash
  curl -X POST https://your-url.com/initialize
  curl -X POST https://your-url.com/submit -H "Content-Type: application/json" -d '{"component_id":"submit_button","input_values":{"departmentChoice":"sales"}}'
  ```

## Next Steps

- Customize the departments in `src/index.ts`
- Add more form fields (text input, dropdown, etc.)
- Save data to your database
- Integrate with other APIs

## Need Help?

- [Intercom Canvas Kit Docs](https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/)
- [Canvas Kit Components](https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/)

