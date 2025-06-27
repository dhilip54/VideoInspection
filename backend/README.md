# Real-Time Video Communication App Backend

This is the backend signaling server for the cross-platform real-time video communication app.

## Features
- Room creation and validation
- WebRTC signaling via Socket.IO
- Auto-delete room when empty

## Getting Started

1. Install dependencies:
   ```sh
   npm install
   ```
2. Start the server:
   ```sh
   node server.js
   ```

---

## Endpoints & Socket Events
- `POST /create-room` - Create a new room, returns Room ID
- `POST /validate-room` - Validate Room ID
- Socket.IO events for signaling: `join`, `signal`, `leave`
