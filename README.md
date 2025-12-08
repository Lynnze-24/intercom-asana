# Intercom Inbox App

A sample Intercom Inbox app built with Node.js and Express using Canvas Kit. This app allows teammates to collect department information about contacts directly from the Intercom Inbox.

## Features

- 📋 Interactive checkbox form for selecting departments
- 🎨 Built with Canvas Kit components
- 🔄 Multi-step flow with submit and refresh actions
- 💼 Works seamlessly in Intercom Inbox

## Prerequisites

- Node.js (v14 or higher)
- Yarn or npm
- An Intercom workspace (free development workspace or paid)
- A tool to expose your local server to the internet (ngrok, localtunnel, etc.)

## Installation

1. Install dependencies:
```bash
yarn install
# or
npm install
```

2. Update the Workspace ID in `src/public/index.html`:
   - Open `src/public/index.html`
   - Find line 37: `const WORKSPACE_ID = 'YOUR-WORKSPACE-ID';`
   - Replace `YOUR-WORKSPACE-ID` with your actual Intercom workspace ID
   - You can find your workspace ID in your Intercom URL: `https://app.intercom.com/a/apps/YOUR-WORKSPACE-ID`

## Development

Run the app:

```bash
yarn start
# or
npm start
```

The server will start on `http://localhost:3000`

## Setting Up Your Intercom App

### 1. Create an Intercom App

1. Go to your [Intercom Developer Hub](https://app.intercom.com/a/apps/_/developer-hub)
2. Click **New app**
3. Give your app a name and description
4. Click **Create app**

### 2. Expose Your Local Server

To test locally, you need to expose your local server to the internet. You can use:

**Using ngrok:**
```bash
ngrok http 3000
```

**Using localtunnel:**
```bash
npx localtunnel --port 3000
```

Copy the public URL provided (e.g., `https://abc123.ngrok.io`)

### 3. Configure Canvas Kit Webhooks

1. In your Intercom app, click **Canvas Kit** in the sidebar
2. Click **For teammates**
3. Check the box **Add to conversation details**
4. Add your webhook endpoints:
   - **Initialize URL**: `https://your-public-url.com/initialize`
   - **Submit URL**: `https://your-public-url.com/submit`
5. Click **Save**
6. Toggle the switch to **On**

### 4. Test Your App

1. Open your app's public URL in a browser (e.g., `https://abc123.ngrok.io`)
2. Send a message using the Intercom Messenger widget in the bottom right
3. Go to your Intercom Inbox and open the conversation
4. Click **Edit Apps** in the bottom right panel
5. Pin your app
6. Click on your app to expand it
7. You should see the department selection form!

## How It Works

### Initialize Endpoint (`/initialize`)

When a teammate opens a conversation with your app added, Intercom sends a POST request to the `/initialize` endpoint. This endpoint returns the initial canvas with:
- A header text
- Checkbox options for departments (Sales, Operations, Engineering)
- A submit button

### Submit Endpoint (`/submit`)

When a teammate clicks a button with a submit action, Intercom sends a POST request to the `/submit` endpoint with:
- `component_id`: The ID of the button that was clicked
- `input_values`: The values selected in the form

The app checks which button was clicked:
- If `submit_button`: Shows a confirmation canvas with the selected department
- If `refresh_button`: Returns to the initial canvas to start over

## Project Structure

```
intercom-app/
├── src/
│   ├── index.js          # Main server file with Express routes
│   └── public/
│       └── index.html    # Frontend HTML with Messenger widget
├── package.json          # Dependencies and scripts
└── README.md            # This file
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the HTML page with endpoint URLs and Messenger |
| `/initialize` | POST | Returns the initial canvas when app is opened |
| `/submit` | POST | Handles form submissions and returns appropriate canvas |

## Canvas Kit Components Used

- **Text**: Header text for the form
- **Checkbox**: Multi-select options for departments
- **Button**: Submit and refresh actions

## Customization

### Adding More Departments

Edit the `initialCanvas` object in `src/index.js`:

```javascript
options: [
  {
    type: 'option',
    id: 'sales',
    text: 'Sales',
  },
  // Add more options here
  {
    type: 'option',
    id: 'marketing',
    text: 'Marketing',
  },
]
```

### Changing the Form Question

Update the text component in `initialCanvas`:

```javascript
{
  type: 'text',
  id: 'department',
  text: 'Your custom question here:',
  align: 'center',
  style: 'header',
}
```

## Resources

- [Intercom Canvas Kit Documentation](https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/)
- [Build an Inbox App Tutorial](https://developers.intercom.com/docs/build-an-integration/getting-started/build-an-app-for-your-inbox)
- [Canvas Kit Components](https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/)

## Troubleshooting

### App not showing in Inbox
- Verify your webhook URLs are correct and publicly accessible
- Check that Canvas Kit is toggled **On** in your Intercom app settings
- Make sure your server is running and responding to requests

### Messenger not loading
- Verify you've replaced `YOUR-WORKSPACE-ID` with your actual workspace ID in `index.html`
- Check the browser console for any errors

### Submit not working
- Check the server logs to see if the `/submit` endpoint is being hit
- Verify the `component_id` values match in your code

## License

ISC

