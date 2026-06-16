# StreamDeck Integration for MSE Viewer

This document explains how to set up Elgato StreamDeck to work with the MSE Viewer application for triggering broadcast graphics.

## Overview

StreamDeck is a hardware controller with programmable buttons that can be configured to send HTTP requests to the MSE Viewer, which in turn controls the Media Sequencer Engine (MSE). This allows for quick and efficient control of broadcast graphics directly from the StreamDeck.

## Requirements

- Elgato StreamDeck device
- StreamDeck software installed
- MSE Viewer application running on a server
- Network connectivity between the StreamDeck computer and the MSE Viewer server

## StreamDeck Configuration

### Installation

1. Install the "Website" or "System: Website" plugin for StreamDeck if not already installed
2. Create new buttons for each MSE command you want to trigger

### Button Configuration

There are two ways to configure StreamDeck buttons:

**Important Note:** The `cleanup` action requires a long press (default 3 seconds, configurable in .env) to prevent accidental activation.

#### Method 1: Using the Friendly URL Scheme

This method is easier to understand and maintain but requires more initial processing by the server.

**URL Format:**
```
http://[server-address]:[port]/api/streamdeck/[action]/[show-name]/[playlist-name]/[page-name]
```

**Example:**
```
http://localhost:3000/api/streamdeck/take/News/OpeningGraphics/Headlines
```

**Parameters:**
- `[action]`: One of `take`, `continue`, `out`, `cleanup`, or `initialize` (Note: `cleanup` requires a long press)
- `[show-name]`: The exact name of the show
- `[playlist-name]`: The exact name of the playlist
- `[page-name]`: The name or value of the page element

#### Method 2: Using the Direct URL Scheme

This method is faster and more direct but requires you to know the exact MSE element URLs ahead of time.

**URL Format:**
```
http://[server-address]:[port]/api/streamdeck/direct/[action]/[page-url]
```

**Example:**
```
http://localhost:3000/api/streamdeck/direct/take/http://mse.server:8580/element/storage/shows/News/elements/Headlines
```

**Parameters:**
- `[action]`: One of `take`, `continue`, `out`, `cleanup`, or `initialize` (Note: `cleanup` requires a long press)
- `[page-url]`: The URL-encoded direct MSE element URL

### Finding Element URLs

To find the exact element URLs for Method 2:

1. Navigate to the MSE Viewer web interface
2. Select the show and playlist you're interested in
3. Select a page from the dropdown menu
4. Open your browser's developer tools (F12) and inspect the network requests when you click on "Take", "Continue", or "Out"
5. Look for a POST request to `/api/profile-command` and check the request payload to find the `elementUrl` value

## StreamDeck Button Setup Instructions

1. Add a new button to your StreamDeck using the "Website" plugin
2. Configure the button with the following settings:
   - **Title**: Give your button a meaningful name (e.g., "News Headlines TAKE")
   - **URL**: Enter one of the URL formats described above
   - **Method**: GET
   - **Icon**: Customize a button icon (red for "Take", blue for "Continue", black for "Out")

3. Repeat for each command and page combination you want to have available on your StreamDeck

## Recommended StreamDeck Layout

For optimal workflow, organize your StreamDeck buttons logically:

### By Show Type
```
+---------------+---------------+---------------+
|    NEWS       |    SPORTS     |    WEATHER    |
|   GRAPHICS    |   GRAPHICS    |   GRAPHICS    |
+---------------+---------------+---------------+
```

### By Command Type (for a specific show)
```
+---------------+---------------+---------------+
|   HEADLINES   |    LOWER      |     FULL      |
|     TAKE      |    THIRDS     |   SCREEN GFX  |
+---------------+---------------+---------------+
|   HEADLINES   |    LOWER      |     FULL      |
|   CONTINUE    |    THIRDS     |   SCREEN GFX  |
+---------------+---------------+---------------+
|   HEADLINES   |    LOWER      |     FULL      |
|     OUT       |    THIRDS     |     OUT       |
+---------------+---------------+---------------+
```

## Troubleshooting

If your StreamDeck buttons don't work as expected:

1. **Check Connectivity**: Ensure the StreamDeck computer can reach the MSE Viewer server
2. **Verify URLs**: Double-check that your URLs are correctly formatted
3. **MSE Status**: Make sure the MSE is running and accessible
4. **Case Sensitivity**: Show names, playlist names, and page names are case-insensitive in the URL, but should match the actual names as closely as possible
5. **Server Logs**: Check the MSE Viewer server logs for error messages when you press a button

## Security Considerations

The StreamDeck integration provides direct command access to your broadcast system. Consider implementing:

1. Network isolation for the MSE and MSE Viewer server
2. Access restrictions at the network level
3. API key authentication (see below)

### Using API Key Authentication

For additional security, the StreamDeck integration supports API key authentication through a URL query parameter:

1. Set the `API_KEY` environment variable in your server configuration or .env file
2. Add the API key as a query parameter to your StreamDeck HTTP requests

**Example StreamDeck configuration with API key:**

1. In the StreamDeck software, create a new button using the "Website" or "System: Website" plugin
2. Configure the button with these settings:
   - Method: GET
   - URL: `http://localhost:3000/api/streamdeck/take/News/Graphics/Headlines?api_key=your_secure_api_key_here`

**Method 1: Friendly URL with API Key**
```
http://[server-address]:[port]/api/streamdeck/[action]/[show-name]/[playlist-name]/[page-name]?api_key=[your-api-key]
```

**Method 2: Direct URL with API Key**
```
http://[server-address]:[port]/api/streamdeck/direct/[action]/[page-url]?api_key=[your-api-key]
```

If an API key is configured on the server, all StreamDeck requests must include this query parameter, or they will be rejected with a 401 Unauthorized error.

## Feedback and Support

If you encounter issues or have suggestions for improving the StreamDeck integration, please contact your system administrator or file an issue in the project repository.